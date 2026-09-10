import prisma from '@/lib/prisma';
import { getPaymentProvider } from '@/lib/payment';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import * as pinService from '@/services/pin.service';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';
import { quoteWithdrawal } from '@/lib/paystack-fees';
import crypto from 'crypto';
import {
  WithdrawBalanceInput,
  PayoutHistoryQueryInput,
} from '@/validators/settlement.validator';
import {
  toNumber,
  getWithdrawalActor,
} from '@/shared/helpers';
import { WalletService } from '@/services/wallet.service';
import { eventBus } from '@/core/events/event-bus';
import { getPayoutPreview } from '@/services/settlement/payout-preview.service';

/**
 * Creates a withdrawal request (admin-approval workflow).
 * No Paystack call on the user path — transfer happens on admin approval or auto-payout.
 * 
 * Triple-fenced against races:
 * 1. Advisory lock (serializes per user)
 * 2. Ledger reservation (pending row deducts from balance)
 * 3. Duplicate guard (same amount within 30 min)
 */
export async function withdrawBalance(
  userId: string,
  businessId: string,
  params: WithdrawBalanceInput
) {
  const business = await getWithdrawalActor(userId, businessId);

  const settlementAccountNumber = business.settlementAccountNumber || business.user.settlementAccountNumber;
  const settlementBankCode = business.settlementBankCode || business.user.settlementBankCode;
  const settlementBankName = business.settlementBankName || business.user.settlementBankName;
  const settlementAccountName = business.settlementAccountName || business.user.settlementAccountName;

  // 1. Check if settlement bank account is connected
  if (!settlementAccountNumber || !settlementBankCode) {
    throw new AppError(
      400,
      'No settlement bank connected. Please connect your commercial bank account first.',
      'SETTLEMENT_ACCOUNT_REQUIRED'
    );
  }

  // 2. Verify 4-digit transaction PIN or step-up authorization token (with lockout protection & bcrypt outside DB tx)
  if (params.stepUpToken) {
    pinService.verifyStepUpToken(userId, params.stepUpToken);
  } else if (params.pin) {
    await pinService.verifyPin(userId, params.pin);
  } else {
    throw new AppError(400, 'Transaction PIN or step-up authorization token is required', 'PIN_REQUIRED');
  }

  // 3. Generate unique transfer reference BEFORE the transaction
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const transferReference = `PO-${dateStr}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

  // 3b. Price the withdrawal against Paystack's published schedule BEFORE the ledger is touched
  let quote: ReturnType<typeof quoteWithdrawal>;
  try {
    quote = quoteWithdrawal(params.amount);
  } catch (err) {
    throw new AppError(
      400,
      err instanceof Error ? err.message : 'Invalid withdrawal amount',
      'INVALID_WITHDRAWAL_AMOUNT'
    );
  }

  const isAutoPayout = Boolean(business.autoPayoutEnabled);
  const initialStatus = isAutoPayout ? 'processing' : 'pending';

  // 4. Atomic request creation with triple-fence protection
  const payout = await prisma.$transaction(async (tx) => {
    // Fence 1: Advisory lock (transaction-scoped, serializes per user to protect central wallet pool)
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${userId}::text, 0)) AS locked
    `;
    if (!locked) {
      throw new AppError(
        409,
        'A withdrawal request is already being processed. Please wait a few seconds and try again.',
        'WITHDRAWAL_IN_PROGRESS'
      );
    }

    // Fence 2: Balance check (tx-aware, honest ledger)
    const preview = await getPayoutPreview(userId, businessId, tx);
    if (quote.amount > preview.availableForWithdrawal) {
      const reservedAmount = preview.pooledPendingWithdrawn ?? preview.pendingWithdrawn ?? 0;
      const isReserved = reservedAmount > 0;
      const message = isReserved
        ? `Insufficient available funds. You have ₦${reservedAmount.toLocaleString('en-NG', {
            minimumFractionDigits: 2,
          })} currently reserved in a pending withdrawal awaiting admin approval. Remaining available: ₦${preview.availableForWithdrawal.toLocaleString(
            'en-NG',
            { minimumFractionDigits: 2 }
          )}.`
        : `Insufficient available funds. Maximum withdrawable balance is ₦${preview.availableForWithdrawal.toLocaleString(
            'en-NG',
            { minimumFractionDigits: 2 }
          )}.`;

      throw new AppError(
        400,
        message,
        'INSUFFICIENT_FUNDS',
        {
          available: preview.availableForWithdrawal,
          pendingWithdrawn: preview.pendingWithdrawn,
          requested: params.amount,
          required: quote.amount,
          withdrawalFee: quote.fee,
          taxReserve: preview.taxReserve,
        }
      );
    }

    // Fence 3: Duplicate guard (same amount awaiting approval/transfer within 30 min across user's businesses)
    const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
    const userBusinesses = await tx.business.findMany({
      where: { userId },
      select: { id: true },
    });
    const userBizIds = userBusinesses.map((b) => b.id);

    const dup = await tx.settlementPayout.findFirst({
      where: {
        businessId: { in: userBizIds },
        amount: quote.amount,
        status: { in: ['pending', 'processing'] },
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { id: true, transferReference: true },
    });
    if (dup) {
      throw new AppError(
        409,
        'You already have a withdrawal request for this exact amount that is awaiting approval or processing.',
        'DUPLICATE_WITHDRAWAL_REQUEST',
        { existingRequestId: dup.id, existingReference: dup.transferReference }
      );
    }

    // Ledger-first: the pending/processing row IS the reservation
    const payoutRecord = await tx.settlementPayout.create({
      data: {
        businessId,
        amount: quote.amount,
        fee: quote.fee,
        netAmount: quote.netAmount,
        destinationBankCode: settlementBankCode,
        destinationBankName: settlementBankName || 'Commercial Bank',
        destinationAccountNum: settlementAccountNumber,
        destinationAccountName: settlementAccountName || business.businessName,
        transferReference,
        status: initialStatus,
        narration: params.narration,
      },
    });

    // Reserve funds on the Central User Wallet inside the transaction fence
    await WalletService.reserveFunds(
      {
        userId,
        amount: quote.amount,
        fee: 0,
        reference: transferReference,
        linkedPayoutId: payoutRecord.id,
        description: `Withdrawal reservation for ${business.businessName}`,
      },
      tx
    );

    return payoutRecord;
  }, { maxWait: 10000, timeout: 20000 });

  // PATH A: Manual Admin Review (autoPayoutEnabled === false)
  if (!isAutoPayout) {
    logAudit({
      userId,
      businessId,
      action: 'settlement.payout_requested',
      resourceType: 'settlement_payout',
      resourceId: payout.id,
      newData: {
        amount: quote.amount,
        fee: quote.fee,
        netAmount: quote.netAmount,
        transferReference,
        destinationBank: settlementBankName,
        accountLast4: settlementAccountNumber.slice(-4),
        mode: 'manual_approval',
      },
    });

    logger.info('Withdrawal request submitted (awaiting admin approval)', {
      businessId,
      payoutId: payout.id,
      amount: quote.amount,
      fee: quote.fee,
      netAmount: quote.netAmount,
      reference: transferReference,
    });

    void createReminderOnce({
      businessId,
      reminderType: 'payout_requested',
      scheduledDate: new Date(),
      message: `Withdrawal request of ${formatNaira(quote.netAmount)}${
        quote.fee > 0 ? ` (after ${formatNaira(quote.fee)} fee)` : ''
      } received (ref ${transferReference}). We'll notify you once it's reviewed — usually within 1–2 business hours.`,
      referenceType: 'settlement_payout',
      referenceId: payout.id,
    }).catch((err) =>
      logger.warn('Failed to create payout_requested reminder', {
        payoutId: payout.id,
        err: err instanceof Error ? err.message : err,
      })
    );

    return {
      id: payout.id,
      amount: toNumber(payout.amount),
      fee: toNumber(payout.fee),
      netAmount: toNumber(payout.netAmount),
      transferReference: payout.transferReference,
      status: payout.status,
      destinationBankName: payout.destinationBankName,
      destinationAccountNum: payout.destinationAccountNum,
      destinationAccountName: payout.destinationAccountName,
      initiatedAt: payout.initiatedAt,
      completedAt: payout.completedAt,
      message:
        toNumber(payout.fee) > 0
          ? `Withdrawal request for ${formatNaira(toNumber(payout.netAmount))} submitted (fee ${formatNaira(
              toNumber(payout.fee)
            )}). It will be processed once approved by an admin.`
          : 'Withdrawal request submitted. It will be processed once approved by an admin.',
    };
  }

  // PATH B: Instant Payout (autoPayoutEnabled === true)
  const provider = getPaymentProvider();
  try {
    const recipient = await provider.createTransferRecipient({
      type: 'nuban',
      name: payout.destinationAccountName,
      accountNumber: payout.destinationAccountNum,
      bankCode: payout.destinationBankCode,
      currency: 'NGN',
      description: `Auto-payout for ${business.businessName}`,
    });

    const transferAmount =
      toNumber(payout.netAmount) > 0 ? toNumber(payout.netAmount) : toNumber(payout.amount);

    // Live Paystack Balance Guard
    const balanceCheck = await WalletService.checkLivePaystackBalance(transferAmount);
    if (!balanceCheck.canPayout) {
      throw new AppError(
        503,
        'Platform settlement balance is currently insufficient to fulfill this transfer. Please try again later or contact support.',
        'GATEWAY_BALANCE_INSUFFICIENT',
        { deficitNaira: balanceCheck.deficit }
      );
    }

    const transferResult = await provider.initiateTransfer({
      source: 'balance',
      amount: transferAmount,
      recipient: recipient.recipientCode,
      reason: payout.narration || `Payout for ${business.businessName}`,
      reference: payout.transferReference,
    });

    const isComplete =
      transferResult.status === 'success' || transferResult.status === 'completed';

    const updated = await prisma.settlementPayout.update({
      where: { id: payout.id },
      data: {
        paystackTransferCode: transferResult.transferCode,
        ...(isComplete ? { status: 'completed', completedAt: new Date() } : {}),
        adminApprovedBy: 'SYSTEM_AUTO_PAYOUT',
        adminApprovedAt: new Date(),
      },
    });

    if (isComplete) {
      await WalletService.settlePayoutDebit({
        userId,
        businessId,
        amount: quote.amount,
        fee: 0,
        reference: payout.transferReference,
        linkedPayoutId: payout.id,
        description: `Instant payout completed for ${business.businessName}`,
      });

      // Post-commit event emission
      eventBus.emit('payout.completed', {
        userId,
        payoutId: payout.id,
        amount: toNumber(payout.amount),
        reference: payout.transferReference,
      });
    }

    logAudit({
      userId,
      businessId,
      action: 'settlement.auto_payout_executed',
      resourceType: 'settlement_payout',
      resourceId: payout.id,
      newData: {
        amount: quote.amount,
        fee: quote.fee,
        netAmount: quote.netAmount,
        transferredToBank: transferAmount,
        transferReference: payout.transferReference,
        paystackTransferCode: transferResult.transferCode,
      },
    });

    logger.info('Auto-payout executed and transfer initiated', {
      payoutId: payout.id,
      businessId,
      amount: quote.amount,
      fee: quote.fee,
      transferredToBank: transferAmount,
      reference: payout.transferReference,
    });

    void createReminderOnce({
      businessId,
      reminderType: 'payout_approved',
      scheduledDate: new Date(),
      message: `Your withdrawal of ${formatNaira(transferAmount)} (ref ${payout.transferReference}) has been processed${
        toNumber(payout.fee) > 0 ? ` (fee ${formatNaira(toNumber(payout.fee))})` : ''
      }. The transfer to your ${payout.destinationBankName} account ••••${payout.destinationAccountNum.slice(-4)} is in progress.`,
      referenceType: 'settlement_payout',
      referenceId: payout.id,
    }).catch((remErr) =>
      logger.warn('Failed to create payout_approved reminder for auto-payout', {
        payoutId: payout.id,
        err: remErr instanceof Error ? remErr.message : remErr,
      })
    );

    return {
      id: updated.id,
      amount: toNumber(updated.amount),
      fee: toNumber(updated.fee),
      netAmount: toNumber(updated.netAmount),
      transferReference: updated.transferReference,
      status: updated.status,
      destinationBankName: updated.destinationBankName,
      destinationAccountNum: updated.destinationAccountNum,
      destinationAccountName: updated.destinationAccountName,
      initiatedAt: updated.initiatedAt,
      completedAt: updated.completedAt,
      message: `Withdrawal of ${formatNaira(transferAmount)} successfully initiated to your bank account.`,
    };
  } catch (err) {
    try {
      await prisma.settlementPayout.update({
        where: { id: payout.id },
        data: {
          status: 'failed',
          failureReason: err instanceof Error ? err.message : String(err),
        },
      });

      // Release locked funds back to available wallet balance on transfer failure
      await WalletService.releaseLockedFunds({
        userId,
        amount: quote.amount,
        fee: 0,
      });

      logAudit({
        userId,
        businessId,
        action: 'settlement.auto_payout_failed',
        resourceType: 'settlement_payout',
        resourceId: payout.id,
        newData: {
          transferReference: payout.transferReference,
          reason: err instanceof Error ? err.message : String(err),
        },
      });

      void createReminderOnce({
        businessId,
        reminderType: 'payout_failed',
        scheduledDate: new Date(),
        message: `The transfer for your withdrawal of ${formatNaira(quote.amount)} could not be processed; the amount is back in your available balance. Support has been notified.`,
        referenceType: 'settlement_payout',
        referenceId: payout.id,
      }).catch((remErr) =>
        logger.warn('Failed to create payout_failed reminder on auto-payout error', {
          payoutId: payout.id,
          err: remErr instanceof Error ? remErr.message : remErr,
        })
      );
    } catch (markErr) {
      logger.error('Failed to mark auto-payout failed after transfer error', {
        payoutId: payout.id,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }

    throw new AppError(
      502,
      `Transfer failed: ${err instanceof Error ? err.message : 'Gateway error'}. Your balance has been restored.`,
      'TRANSFER_FAILED'
    );
  }
}

/**
 * Returns paginated payout history for a business
 */
export async function listPayoutHistory(
  userId: string,
  businessId: string,
  query: PayoutHistoryQueryInput
) {
  await getWithdrawalActor(userId, businessId);

  const where: any = { businessId };
  if (query.status) {
    where.status = query.status;
  }
  if (query.search) {
    where.OR = [
      { transferReference: { contains: query.search, mode: 'insensitive' } },
      { destinationBankName: { contains: query.search, mode: 'insensitive' } },
      { destinationAccountName: { contains: query.search, mode: 'insensitive' } },
      { destinationAccountNum: { contains: query.search } },
      { narration: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.settlementPayout.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.settlementPayout.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit) || 1;

  return {
    items: items.map((p) => ({
      id: p.id,
      amount: toNumber(p.amount),
      fee: toNumber(p.fee),
      netAmount: toNumber(p.netAmount),
      destinationBankName: p.destinationBankName,
      destinationAccountNum: p.destinationAccountNum,
      destinationAccountName: p.destinationAccountName,
      transferReference: p.transferReference,
      status: p.status,
      failureReason: p.failureReason,
      initiatedAt: p.initiatedAt,
      completedAt: p.completedAt,
      narration: p.narration,
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: query.page < totalPages,
      hasPrev: query.page > 1,
    },
  };
}
