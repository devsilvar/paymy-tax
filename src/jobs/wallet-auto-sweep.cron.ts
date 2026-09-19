// Nightly Wallet Auto-Sweep Cron — runs at 02:00 Africa/Lagos.
//
// Regulatory Mandate:
//   Clears accumulated merchant balances above threshold (default ₦1,000)
//   to their verified commercial bank accounts (NUBAN).
//   Ensures WallX operates strictly as a payment transit clearing gateway
//   and not an unlicensed deposit-taking / stored-value institution under CBN guidelines.
//
// Concurrency:
//   Wrapped in Postgres transaction-scoped advisory lock (LOCK_KEY = 947365).
//   Uses pg_try_advisory_xact_lock inside $transaction fence so PostgreSQL
//   automatically releases the lock upon commit or rollback without leaking
//   session locks across connection poolers (PgBouncer/Neon/Supabase).
//   Guarantees single execution across clustered/multi-container deployments.
//
// Lock directory reference:
//   947362 — daily reminder sweep (reminders.cron.ts)
//   947363 — wallet reconciliation sweep (wallet-reconciliation.cron.ts)
//   947364 — payout reconciliation sweep (payout-reconciliation.cron.ts)
//   947365 — wallet auto-sweep (wallet-auto-sweep.cron.ts)

import cron from 'node-cron';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import config from '../config';
import { toNumber } from '../shared/helpers/number';
import { PlatformConfigService } from '../services/platform-config.service';
import { quoteAutoSweep } from '../lib/paystack-fees';
import { WalletService } from '../services/wallet.service';
import { getPaymentProvider } from '../lib/payment';
import { isAmbiguousTransferError } from '../lib/payment/errors';
import { logAudit } from '../lib/audit';
import { createReminderOnce } from '../services/reminder.service';
import { formatNaira } from '../lib/format';
import { eventBus } from '../core/events/event-bus';

const LOCK_KEY = 947365;
const TIMEZONE = 'Africa/Lagos';

export function registerAutoSweepCron(): void {
  if (!config.autoSweep.enabled) {
    logger.info(
      'Wallet auto-sweep cron skipped (set AUTO_SWEEP_ENABLED=true to enable in non-production)'
    );
    return;
  }

  cron.schedule(
    config.autoSweep.schedule,
    () => {
      void runAutoSweep();
    },
    { timezone: TIMEZONE }
  );
  logger.info('Wallet auto-sweep cron registered', {
    schedule: config.autoSweep.schedule,
    timezone: TIMEZONE,
    thresholdNaira: config.autoSweep.thresholdNaira,
  });
}

export interface AutoSweepResult {
  walletsChecked: number;
  sweepsAttempted: number;
  sweepsCompleted: number;
  sweepsFailed: number;
  skippedNoBank: number;
  skippedBelowMin: number;
  skippedAlreadySwept: number;
  totalSweptNaira: number;
}

export async function runAutoSweep(opts?: {
  bypassLock?: boolean;
  force?: boolean;
}): Promise<AutoSweepResult> {
  if (opts?.bypassLock) {
    return await executeSweep(opts?.force);
  }

  return await prisma.$transaction(
    async (tx) => {
      const lockResult = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
      `;
      const locked = lockResult[0]?.locked === true;

      if (!locked) {
        logger.warn('Wallet auto-sweep skipped — another worker holds the lock', {
          lockKey: LOCK_KEY,
        });
        return {
          walletsChecked: 0,
          sweepsAttempted: 0,
          sweepsCompleted: 0,
          sweepsFailed: 0,
          skippedNoBank: 0,
          skippedBelowMin: 0,
          skippedAlreadySwept: 0,
          totalSweptNaira: 0,
        };
      }

      return await executeSweep(opts?.force);
    },
    { maxWait: 10000, timeout: 600000 } // 10-minute timeout for batch sweep
  );
}

async function executeSweep(force = false): Promise<AutoSweepResult> {
  const sweepConfig = await PlatformConfigService.isAutoSweepEnabled();
  if (!sweepConfig.enabled && !force) {
    logger.info(
      '[AUTO_SWEEP] Auto-sweep engine is administratively disabled in platform settings. Skipping execution.'
    );
    return {
      walletsChecked: 0,
      sweepsAttempted: 0,
      sweepsCompleted: 0,
      sweepsFailed: 0,
      skippedNoBank: 0,
      skippedBelowMin: 0,
      skippedAlreadySwept: 0,
      totalSweptNaira: 0,
    };
  }

  const threshold = sweepConfig.thresholdNaira || config.autoSweep.thresholdNaira;

  logger.info('Starting daily wallet anti-deposit auto-sweep', {
    thresholdNaira: threshold,
    administrativelyForced: force,
  });

  const wallets = await prisma.walletBalance.findMany({
    where: {
      balance: { gte: threshold },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          settlementAccountNumber: true,
          settlementBankCode: true,
          settlementBankName: true,
          settlementAccountName: true,
          businesses: {
            select: {
              id: true,
              businessName: true,
              settlementAccountNumber: true,
              settlementBankCode: true,
              settlementBankName: true,
              settlementAccountName: true,
              autoPayoutEnabled: true,
            },
          },
        },
      },
    },
  });

  let walletsChecked = 0;
  let sweepsAttempted = 0;
  let sweepsCompleted = 0;
  let sweepsFailed = 0;
  let skippedNoBank = 0;
  let skippedBelowMin = 0;
  let skippedAlreadySwept = 0;
  let totalSweptNaira = 0;

  const feeConfig = await PlatformConfigService.getFeeConfig();
  const provider = getPaymentProvider();

  // Daily dedup: skip businesses already swept today to prevent the
  // sweep → auto-sync-refill → re-sweep loop that caused double-withdrawals.
  // Uses the SWEEP-{YYYYMMDD} prefix baked into every transferReference.
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const todaysSweeps = await prisma.settlementPayout.findMany({
    where: {
      transferReference: { startsWith: `SWEEP-${todayStr}` },
      status: { in: ['processing', 'completed'] },
    },
    select: { businessId: true },
  });
  const alreadySweptBizIds = new Set(todaysSweeps.map((p) => p.businessId));

  for (const wallet of wallets) {
    walletsChecked++;
    const totalBalance = toNumber(wallet.balance);
    const lockedBalance = toNumber(wallet.lockedBalance);
    const available = Math.max(0, totalBalance - lockedBalance);

    if (available < threshold) {
      continue;
    }

    // 1. Resolve primary business record
    const primaryBiz =
      wallet.user.businesses.find(
        (b) => Boolean(b.settlementAccountNumber && b.settlementBankCode)
      ) || wallet.user.businesses[0];

    if (!primaryBiz) {
      logger.warn('[AUTO_SWEEP] Skipping user — no associated business record found', {
        userId: wallet.userId,
      });
      skippedNoBank++;
      continue;
    }

    // 1b. Daily dedup: skip if this business was already swept today
    if (alreadySweptBizIds.has(primaryBiz.id)) {
      logger.info('[AUTO_SWEEP] Skipping — business already swept today', {
        userId: wallet.userId,
        businessId: primaryBiz.id,
        businessName: primaryBiz.businessName,
      });
      skippedAlreadySwept++;
      continue;
    }

    // 2. Resolve destination bank account
    const destinationBankCode =
      primaryBiz.settlementBankCode || wallet.user.settlementBankCode;
    const destinationAccountNum =
      primaryBiz.settlementAccountNumber || wallet.user.settlementAccountNumber;
    const destinationBankName =
      primaryBiz.settlementBankName || wallet.user.settlementBankName || 'Commercial Bank';
    const destinationAccountName =
      primaryBiz.settlementAccountName ||
      wallet.user.settlementAccountName ||
      primaryBiz.businessName ||
      'Account Holder';

    if (!destinationBankCode || !destinationAccountNum) {
      logger.info('[AUTO_SWEEP] Skipping user — no settlement bank connected', {
        userId: wallet.userId,
        email: wallet.user.email,
        availableNaira: available,
      });
      skippedNoBank++;
      continue;
    }

    // 3. Quote withdrawal fees with auto-sweep debit capping
    let quote: ReturnType<typeof quoteAutoSweep>;
    try {
      quote = quoteAutoSweep(available, {
        pct: feeConfig.withdrawalFeePct,
        cap: feeConfig.withdrawalFeeCap,
        minAmount: feeConfig.minWithdrawalAmount,
      });
    } catch {
      logger.info('[AUTO_SWEEP] Skipping user — available amount below minimum withdrawal', {
        userId: wallet.userId,
        availableNaira: available,
        minRequired: feeConfig.minWithdrawalAmount,
      });
      skippedBelowMin++;
      continue;
    }

    const transferAmount =
      quote.netAmount > 0 ? quote.netAmount : quote.amount;

    // 3. Live Paystack Gateway Solvency Check
    const balanceCheck = await WalletService.checkLivePaystackBalance(transferAmount);
    if (!balanceCheck.canPayout) {
      logger.error('[AUTO_SWEEP] Halting sweep batch — Paystack balance insufficient', {
        requiredNaira: transferAmount,
        paystackBalanceNaira: balanceCheck.paystackBalanceNaira,
        deficitNaira: balanceCheck.deficit,
      });
      break; // Gateway balance depleted: halt entire sweep
    }

    sweepsAttempted++;

    // 4. Generate unique transfer reference
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const transferReference = `SWEEP-${dateStr}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

    // 5. Atomic request creation and ledger reservation
    let payoutRecord;
    try {
      payoutRecord = await prisma.$transaction(
        async (tx) => {
          // Advisory lock per user to serialize with any concurrent withdrawal
          const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${wallet.userId}::text, 0)) AS locked
          `;
          if (!locked) {
            throw new Error('CONCURRENT_USER_OPERATION');
          }

          // Create processing settlement payout
          const payout = await tx.settlementPayout.create({
            data: {
              businessId: primaryBiz.id,
              amount: quote.amount,
              fee: quote.fee,
              netAmount: quote.netAmount,
              destinationBankCode,
              destinationBankName,
              destinationAccountNum,
              destinationAccountName,
              transferReference,
              status: 'processing',
              narration: 'Auto-sweep: regulatory clearing',
            },
          });

          // Reserve funds on central wallet ledger
          await WalletService.reserveFunds(
            {
              userId: wallet.userId,
              amount: quote.amount,
              fee: 0,
              reference: transferReference,
              linkedPayoutId: payout.id,
              description: `Auto-sweep clearing for ${primaryBiz.businessName}`,
            },
            tx
          );

          return payout;
        },
        { maxWait: 10000, timeout: 30000 }
      );
    } catch (createErr: any) {
      sweepsFailed++;
      logger.warn('[AUTO_SWEEP] Failed to reserve funds for auto-sweep', {
        userId: wallet.userId,
        businessId: primaryBiz.id,
        error: createErr?.message,
      });
      continue;
    }

    // 6. External Gateway Transfer (outside DB transaction)
    try {
      const recipient = await provider.createTransferRecipient({
        type: 'nuban',
        name: payoutRecord.destinationAccountName,
        accountNumber: payoutRecord.destinationAccountNum,
        bankCode: payoutRecord.destinationBankCode,
        currency: 'NGN',
        description: `Auto-sweep for ${primaryBiz.businessName}`,
      });

      const transferResult = await provider.initiateTransfer({
        source: 'balance',
        amount: transferAmount,
        recipient: recipient.recipientCode,
        reason: payoutRecord.narration || `Auto-sweep for ${primaryBiz.businessName}`,
        reference: payoutRecord.transferReference,
      });

      const isComplete =
        transferResult.status === 'success' || transferResult.status === 'completed';

      await prisma.settlementPayout.update({
        where: { id: payoutRecord.id },
        data: {
          paystackTransferCode: transferResult.transferCode,
          ...(isComplete ? { status: 'completed', completedAt: new Date() } : {}),
          adminApprovedBy: 'SYSTEM_AUTO_SWEEP',
          adminApprovedAt: new Date(),
        },
      });

      if (isComplete) {
        await WalletService.settlePayoutDebit({
          userId: wallet.userId,
          businessId: primaryBiz.id,
          amount: quote.amount,
          fee: 0,
          reference: payoutRecord.transferReference,
          linkedPayoutId: payoutRecord.id,
          description: `Auto-sweep payout completed for ${primaryBiz.businessName}`,
        });

        eventBus.emit('payout.completed', {
          userId: wallet.userId,
          payoutId: payoutRecord.id,
          amount: toNumber(payoutRecord.amount),
          reference: payoutRecord.transferReference,
        });
      }

      sweepsCompleted++;
      totalSweptNaira += quote.amount;

      logAudit({
        userId: wallet.userId,
        businessId: primaryBiz.id,
        action: 'settlement.auto_sweep_executed',
        resourceType: 'settlement_payout',
        resourceId: payoutRecord.id,
        newData: {
          amount: quote.amount,
          fee: quote.fee,
          netAmount: quote.netAmount,
          transferReference: payoutRecord.transferReference,
          paystackTransferCode: transferResult.transferCode,
        },
      });

      logger.info('[AUTO_SWEEP] Auto-sweep completed successfully', {
        userId: wallet.userId,
        businessId: primaryBiz.id,
        amountNaira: quote.amount,
        reference: payoutRecord.transferReference,
      });

      void createReminderOnce({
        businessId: primaryBiz.id,
        reminderType: 'payout_approved',
        scheduledDate: new Date(),
        message: `Auto-sweep of ${formatNaira(transferAmount)} (ref ${payoutRecord.transferReference}) was initiated to your ${payoutRecord.destinationBankName} account ••••${payoutRecord.destinationAccountNum.slice(-4)}. Balances are cleared daily in compliance with CBN non-deposit regulations.`,
        referenceType: 'settlement_payout',
        referenceId: payoutRecord.id,
      }).catch(() => {});
    } catch (transferErr: any) {
      sweepsFailed++;
      if (isAmbiguousTransferError(transferErr)) {
        await prisma.settlementPayout.update({
          where: { id: payoutRecord.id },
          data: {
            status: 'processing',
            failureReason: `Gateway timeout / transport error during auto-sweep transfer. Awaiting reconciliation. Original error: ${transferErr instanceof Error ? transferErr.message : String(transferErr)}`,
            updatedAt: new Date(),
          },
        });

        logger.error(
          '[AUTO_SWEEP_AMBIGUOUS] Auto-sweep transfer status uncertain — funds remain locked for reconciliation',
          {
            payoutId: payoutRecord.id,
            userId: wallet.userId,
            transferReference: payoutRecord.transferReference,
            error: transferErr instanceof Error ? transferErr.message : String(transferErr),
          }
        );

        logAudit({
          userId: wallet.userId,
          businessId: primaryBiz.id,
          action: 'settlement.auto_sweep_ambiguous',
          resourceType: 'settlement_payout',
          resourceId: payoutRecord.id,
          newData: {
            transferReference: payoutRecord.transferReference,
            reason: transferErr instanceof Error ? transferErr.message : String(transferErr),
          },
        });
      } else {
        await prisma.settlementPayout.update({
          where: { id: payoutRecord.id },
          data: {
            status: 'failed',
            failureReason: transferErr instanceof Error ? transferErr.message : String(transferErr),
          },
        });

        await WalletService.releaseLockedFunds({
          userId: wallet.userId,
          amount: quote.amount,
          fee: 0,
        });

        logger.warn('[AUTO_SWEEP_FAILED] Auto-sweep transfer failed — balance restored', {
          payoutId: payoutRecord.id,
          userId: wallet.userId,
          transferReference: payoutRecord.transferReference,
          error: transferErr instanceof Error ? transferErr.message : String(transferErr),
        });

        logAudit({
          userId: wallet.userId,
          businessId: primaryBiz.id,
          action: 'settlement.auto_sweep_failed',
          resourceType: 'settlement_payout',
          resourceId: payoutRecord.id,
          newData: {
            transferReference: payoutRecord.transferReference,
            reason: transferErr instanceof Error ? transferErr.message : String(transferErr),
          },
        });
      }
    }
  }

  logger.info('Wallet anti-deposit auto-sweep finished', {
    walletsChecked,
    sweepsAttempted,
    sweepsCompleted,
    sweepsFailed,
    skippedNoBank,
    skippedBelowMin,
    skippedAlreadySwept,
    totalSweptNaira,
  });

  return {
    walletsChecked,
    sweepsAttempted,
    sweepsCompleted,
    sweepsFailed,
    skippedNoBank,
    skippedBelowMin,
    skippedAlreadySwept,
    totalSweptNaira,
  };
}
