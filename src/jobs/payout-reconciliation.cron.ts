import cron from 'node-cron';
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { config } from '@/config';
import { getPaymentProvider } from '@/lib/payment';
import { WalletService } from '@/services/wallet.service';
import { eventBus } from '@/core/events/event-bus';
import { logAudit } from '@/lib/audit';
import { createReminderOnce } from '@/services/reminder/reminder-generation.service';
import { formatNaira } from '@/lib/format';
import { toNumber } from '@/shared/helpers';

/**
 * Allocated 32-bit integer for Postgres transaction advisory lock:
 *   947362 = Reminder daily sweep
 *   947363 = Wallet ledger reconciliation
 *   947364 = Payout transfer reconciliation
 */
const LOCK_KEY = 947364;

export interface PayoutReconciliationResult {
  payoutsAudited: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
}

/**
 * Reconciles stuck settlement payouts by querying Paystack transfer verification API.
 * Ensures merchant withdrawals never remain indefinitely stuck in 'processing' / 'pending'.
 */
export async function executePayoutReconciliationSweep(): Promise<PayoutReconciliationResult> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  // Fetch payouts initiated >10 mins ago that have a Paystack transfer code and are still pending/processing
  const stuckPayouts = await prisma.settlementPayout.findMany({
    where: {
      status: { in: ['processing', 'pending'] },
      paystackTransferCode: { not: null },
      initiatedAt: { lte: tenMinutesAgo },
    },
    include: {
      business: {
        select: {
          id: true,
          userId: true,
          businessName: true,
        },
      },
    },
    orderBy: { initiatedAt: 'asc' },
  });

  if (stuckPayouts.length === 0) {
    logger.debug('Payout reconciliation sweep: zero stuck payouts found');
    return { payoutsAudited: 0, completedCount: 0, failedCount: 0, pendingCount: 0 };
  }

  logger.info('Payout reconciliation sweep: auditing stuck payouts', { count: stuckPayouts.length });

  let completedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;

  const provider = getPaymentProvider();

  for (const payout of stuckPayouts) {
    try {
      if (typeof provider.verifyTransfer !== 'function') {
        logger.warn('Payment provider does not support verifyTransfer');
        break;
      }

      const result = await provider.verifyTransfer(payout.transferReference);
      const paystackStatus = result.status?.toLowerCase();

      // Guard against race conditions: refresh payout status
      const current = await prisma.settlementPayout.findUnique({
        where: { id: payout.id },
        select: { status: true },
      });

      if (current?.status === 'completed' || current?.status === 'failed') {
        continue;
      }

      if (paystackStatus === 'success' || paystackStatus === 'completed') {
        await prisma.settlementPayout.update({
          where: { id: payout.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });

        if (payout.business?.userId) {
          await WalletService.settlePayoutDebit({
            userId: payout.business.userId,
            businessId: payout.businessId,
            amount: toNumber(payout.amount),
            fee: 0,
            reference: payout.transferReference,
            linkedPayoutId: payout.id,
            description: `Settlement payout completed via automated reconciliation to ${payout.destinationBankName}`,
          });

          eventBus.emit('payout.completed', {
            userId: payout.business.userId,
            payoutId: payout.id,
            amount: toNumber(payout.amount),
            reference: payout.transferReference,
          });
        }

        logAudit({
          businessId: payout.businessId,
          action: 'settlement.payout_reconciled_completed',
          resourceType: 'settlement_payout',
          resourceId: payout.id,
          newData: {
            status: 'completed',
            transferReference: payout.transferReference,
            paystackStatus,
          },
        });

        try {
          await createReminderOnce({
            businessId: payout.businessId,
            reminderType: 'payout_completed',
            scheduledDate: new Date(),
            message: `Your withdrawal of ${formatNaira(
              toNumber(payout.netAmount) > 0 ? toNumber(payout.netAmount) : toNumber(payout.amount)
            )} (ref ${payout.transferReference}) has been verified and transferred to your ${payout.destinationBankName} account.`,
            referenceType: 'settlement_payout',
            referenceId: payout.id,
          });
        } catch (err: any) {
          logger.warn('Failed to create payout_completed reminder during reconciliation', {
            payoutId: payout.id,
            err: err instanceof Error ? err.message : err,
          });
        }

        completedCount++;
      } else if (paystackStatus === 'failed' || paystackStatus === 'reversed') {
        await prisma.settlementPayout.update({
          where: { id: payout.id },
          data: {
            status: 'failed',
            failureReason: result.gatewayResponse || 'Transfer failed at destination bank or gateway',
          },
        });

        if (payout.business?.userId) {
          await WalletService.releaseLockedFunds({
            userId: payout.business.userId,
            amount: payout.amount,
            fee: 0,
          });
        }

        logAudit({
          businessId: payout.businessId,
          action: 'settlement.payout_reconciled_failed',
          resourceType: 'settlement_payout',
          resourceId: payout.id,
          newData: {
            status: 'failed',
            transferReference: payout.transferReference,
            reason: result.gatewayResponse,
          },
        });

        try {
          await createReminderOnce({
            businessId: payout.businessId,
            reminderType: 'payout_failed',
            scheduledDate: new Date(),
            message: `Your withdrawal of ${formatNaira(
              toNumber(payout.amount)
            )} (ref ${payout.transferReference}) could not be completed and funds have been released back to your available balance.`,
            referenceType: 'settlement_payout',
            referenceId: payout.id,
          });
        } catch (err: any) {
          logger.warn('Failed to create payout_failed reminder during reconciliation', {
            payoutId: payout.id,
            err: err instanceof Error ? err.message : err,
          });
        }

        failedCount++;
      } else {
        // Transfer is still in progress / pending upstream
        pendingCount++;
        logger.debug('Payout transfer still pending at gateway', {
          payoutId: payout.id,
          reference: payout.transferReference,
          status: paystackStatus,
        });
      }
    } catch (payoutErr: any) {
      // Isolate individual payout errors so one network issue does not fail the entire sweep
      logger.error('Error reconciling individual payout transfer', {
        payoutId: payout.id,
        reference: payout.transferReference,
        error: payoutErr.message,
      });
    }
  }

  logger.info('Payout reconciliation sweep completed', {
    payoutsAudited: stuckPayouts.length,
    completedCount,
    failedCount,
    pendingCount,
  });

  return {
    payoutsAudited: stuckPayouts.length,
    completedCount,
    failedCount,
    pendingCount,
  };
}

/**
 * Runs the payout reconciliation sweep wrapped in a transaction-scoped Postgres advisory lock.
 */
export async function runPayoutReconciliationSweep(opts?: {
  bypassLock?: boolean;
}): Promise<PayoutReconciliationResult> {
  if (opts?.bypassLock) {
    return await executePayoutReconciliationSweep();
  }

  return await prisma.$transaction(
    async (tx) => {
      const lockResult = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
      `;
      const locked = lockResult[0]?.locked === true;

      if (!locked) {
        logger.warn('Payout reconciliation sweep skipped — another worker holds the lock', {
          lockKey: LOCK_KEY,
        });
        return { payoutsAudited: 0, completedCount: 0, failedCount: 0, pendingCount: 0 };
      }

      return await executePayoutReconciliationSweep();
    },
    { maxWait: 10000, timeout: 60000 }
  );
}

/**
 * Registers the 15-minute payout reconciliation cron job.
 */
export function registerPayoutReconciliationCron(): void {
  if (!config.cron.enabled) {
    logger.info('Payout reconciliation cron: disabled (cron.enabled is false)');
    return;
  }

  // Run every 15 minutes
  cron.schedule(
    '*/15 * * * *',
    async () => {
      try {
        await runPayoutReconciliationSweep();
      } catch (err: any) {
        logger.error('Payout reconciliation sweep failed', { error: err.message });
      }
    },
    { timezone: 'Africa/Lagos' }
  );

  logger.info('Payout reconciliation cron registered: every 15 minutes (Africa/Lagos)');
}
