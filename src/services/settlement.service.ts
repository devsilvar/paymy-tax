import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { getPaymentProvider } from '@/lib/payment';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import * as pinService from '@/services/pin.service';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';
import {
  dvaFeeCapThreshold,
  dvaFeeTotalFromBuckets,
  feeSchedule,
  quoteWithdrawal,
} from '@/lib/paystack-fees';
import config from '@/config';
import crypto from 'crypto';
import {
  WithdrawBalanceInput,
  ToggleAutoSplitInput,
  PayoutHistoryQueryInput,
  ConnectSettlementInput,
  ResolveSettlementInput,
} from '@/validators/settlement.validator';

function toNumber(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof (val as any).toNumber === 'function') return (val as any).toNumber();
  const parsed = Number(val);
  return isNaN(parsed) ? 0 : parsed;
}

async function verifyBusinessOwnership(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          transactionPin: true,
          pinLockedUntil: true,
          pinAttempts: true,
        },
      },
    },
  });

  if (!business) {
    throw new AppError(404, 'Business not found or access denied', 'BUSINESS_NOT_FOUND');
  }

  return business;
}

/**
 * Computes available withdrawal balance, tax due (display-only), and settlement details.
 *
 * Withdrawal-hold semantics (Option A, Sep 2026): unpaid tax is reported via
 * `taxReserve` for UI/reminders but is NOT subtracted from
 * `availableForWithdrawal`. The 7.5% auto-split still sets tax aside at
 * Paystack; see the comment at the balance computation below.
 *
 * @param tx - Optional transaction client (for use inside withdraw/approve fences)
 * @param opts - Optional excludePayoutId (for admin approve-time recheck)
 */
export async function getPayoutPreview(
  userId: string,
  businessId: string,
  tx?: Prisma.TransactionClient,
  opts?: { excludePayoutId?: string }
) {
  const business = await verifyBusinessOwnership(userId, businessId);
  const db = tx ?? prisma;

  // 1. DVA Inflows breakdown:
  // DVA-originated inflows only — matches getDVABalance (dva.service.ts:363-367).
  // Manually-entered bank transfers never touched the platform balance and
  // MUST NOT be withdrawable. (noticepay.md NEW-B & NEW-K)
  
  // Platform-held share of split-settled inflows.
  // Settled-status rule: DVA inflows are created 'pending' and flipped to
  // 'confirmed' on verification — they are NEVER 'completed'. Counting only
  // 'completed' zeroed out platform-held funds. 'confirmed' is canonical;
  // 'completed' kept for legacy rows. Matches getDVABalance + e2e test NEW-B.
  const splitAgg = await db.salesTransaction.aggregate({
    where: {
      businessId,
      source: 'bank_transfer',
      status: { in: ['confirmed', 'completed'] },
      metadata: { path: ['channel'], equals: 'dva' },
      settledViaSplit: true,
    },
    _sum: {
      platformRetained: true,
    },
  });
  const totalPlatformRetained = toNumber(splitAgg._sum.platformRetained ?? 0);

  // Plain (non-split) inflows count in full — same settled-status rule.
  const plainAgg = await db.salesTransaction.aggregate({
    where: {
      businessId,
      source: 'bank_transfer',
      status: { in: ['confirmed', 'completed'] },
      metadata: { path: ['channel'], equals: 'dva' },
      settledViaSplit: false,
    },
    _sum: {
      amount: true,
    },
  });
  const totalPlainInflows = toNumber(plainAgg._sum.amount ?? 0);

  // ALL settled DVA inflows — display + tax fallback only (same rule).
  const allAgg = await db.salesTransaction.aggregate({
    where: {
      businessId,
      source: 'bank_transfer',
      status: { in: ['confirmed', 'completed'] },
      metadata: { path: ['channel'], equals: 'dva' },
    },
    _sum: {
      amount: true,
    },
  });
  const totalInflowsAll = toNumber(allAgg._sum.amount ?? 0);
  const platformHeldFunds = totalPlainInflows + totalPlatformRetained;
  // 1b. Processing fees Paystack has ALREADY taken on those inflows.
  // Paystack deducts its DVA charge (1% per transfer, capped at ₦300) before it
  // settles, so the balance we can really transfer out is gross inflows MINUS
  // those fees. Leaving them out makes `availableForWithdrawal` a promise
  // Paystack's balance cannot keep — the transfer dies at the last step.
  // fee(n) = min(n * pct/100, cap), so the exact total over many rows is
  //   pct/100 * Σ(below-threshold amounts) + cap * count(above-threshold rows).
  let estimatedProcessingFees = 0;
  const capThreshold = dvaFeeCapThreshold();
  if (Number.isFinite(capThreshold)) {
    const dvaBase: Prisma.SalesTransactionWhereInput = {
      businessId,
      source: 'bank_transfer',
      status: { in: ['confirmed', 'completed'] },
      metadata: { path: ['channel'], equals: 'dva' },
    };

    // Plain inflows pool 100% on the platform, so the platform bears the full fee.
    const plainBelow = await db.salesTransaction.aggregate({
      where: { ...dvaBase, settledViaSplit: false, amount: { lte: capThreshold } },
      _sum: { amount: true },
    });
    const plainAbove = await db.salesTransaction.count({
      where: { ...dvaBase, settledViaSplit: false, amount: { gt: capThreshold } },
    });

    // Split-settled inflows: the SME's subaccount already took its share, so the
    // platform only bears the fee on the slice it retained.
    const splitBelow = await db.salesTransaction.aggregate({
      where: { ...dvaBase, settledViaSplit: true, platformRetained: { lte: capThreshold } },
      _sum: { platformRetained: true },
    });
    const splitAbove = await db.salesTransaction.count({
      where: { ...dvaBase, settledViaSplit: true, platformRetained: { gt: capThreshold } },
    });

    estimatedProcessingFees =
      dvaFeeTotalFromBuckets(toNumber(plainBelow._sum.amount ?? 0), plainAbove) +
      dvaFeeTotalFromBuckets(toNumber(splitBelow._sum.platformRetained ?? 0), splitAbove);
  }

  // 2. Total completed / pending / processing withdrawals
  // processing = transfer initiated (admin-approved), pending = awaiting admin approval
  const payoutsWhere: any = {
    businessId,
    status: { in: ['completed', 'pending', 'processing'] },
  };
  // When rechecking affordability at approval time, exclude the payout being approved
  if (opts?.excludePayoutId) {
    payoutsWhere.id = { not: opts.excludePayoutId };
  }
  const payoutsAggregate = await db.settlementPayout.aggregate({
    where: payoutsWhere,
    _sum: {
      amount: true,
    },
  });
  const totalWithdrawn = toNumber(payoutsAggregate._sum.amount ?? 0);

  const [completedAggregate, pendingAggregate] = await Promise.all([
    db.settlementPayout.aggregate({
      where: { businessId, status: 'completed' },
      _sum: { amount: true },
    }),
    db.settlementPayout.aggregate({
      where: { businessId, status: { in: ['pending', 'processing'] } },
      _sum: { amount: true },
    }),
  ]);
  const completedWithdrawn = toNumber(completedAggregate._sum.amount ?? 0);
  const pendingWithdrawn = toNumber(pendingAggregate._sum.amount ?? 0);

  // 3. Tax Liability calculation (unpaid reports or estimated monthly liability)
  // Check active unpaid monthly reports
  const unpaidReports = await db.monthlyTaxReport.findMany({
    where: {
      businessId,
      paymentStatus: { in: ['pending', 'failed'] },
    },
  });

  let estimatedTaxLiability = 0;
  for (const report of unpaidReports) {
    estimatedTaxLiability += toNumber(report.taxPayable);
  }

  // If no finalized reports yet, compute 7.5% tax escrow reserve on total sales minus expenses.
  // Tax fallback MUST use totalInflowsAll because tax is owed on total revenue regardless of split. (NEW-K)
  if (unpaidReports.length === 0 && totalInflowsAll > 0) {
    const totalExpensesAgg = await db.expense.aggregate({
      where: { businessId, isDeductible: true },
      _sum: { amount: true },
    });
    const totalExpenses = toNumber(totalExpensesAgg._sum.amount ?? 0);
    const grossProfit = Math.max(0, totalInflowsAll - totalExpenses);
    estimatedTaxLiability = Math.round(grossProfit * 0.075 * 100) / 100;
  }

  // 4. Tax due (display-only) and available balance.
  //
  // OPTION A — WITHDRAWAL HOLD REMOVED (product decision, Sep 2026):
  // availableForWithdrawal no longer subtracts unpaid tax. The 7.5% auto-split
  // still sets tax aside PHYSICALLY at Paystack (platformRetained per transfer),
  // so the mechanism that accumulates tax money is unchanged — but the SME can
  // now withdraw their full platform-held balance at any time. Rationale: the
  // previous hold blocked funds that were never actually applied to tax (tax
  // is paid via a fresh Paystack charge), which confused users without
  // protecting anything. Unpaid tax surfaces as `taxReserve` (display +
  // reminders) instead of a silent balance reduction. If a true escrow
  // (held funds auto-pay finalized reports) is built later, reintroduce the
  // subtraction at that time.

// 4. Safe available balance — cannot withdraw funds reserved for unpaid FIRS
  //    taxes, and cannot promise naira Paystack already kept as processing fees.

  const taxReserve = Math.max(0, estimatedTaxLiability);

  // Available balance: Platform-held DVA funds minus already taken Paystack DVA processing fees minus total withdrawals.
  // Note: Tax reserve is NOT deducted from available balance (user pays tax via Tax Reports, we do not lock escrow).
  const availableForWithdrawal = Math.max(
    0,
    Math.round(
      (platformHeldFunds - estimatedProcessingFees - totalWithdrawn) * 100
    ) / 100
  );

  const isPinLocked = Boolean(
    business.user.pinLockedUntil && business.user.pinLockedUntil > new Date()
  );

  // Import lock status helper
  const { getPayoutLockStatus } = await import('@/lib/payout-lock');
  const payoutChangeLock = getPayoutLockStatus(business);

  return {
    businessId: business.id,
    businessName: business.businessName,
    walletBalance: availableForWithdrawal,
    availableForWithdrawal,
    totalInflows: totalInflowsAll,
    totalSplitSettled: Math.max(0, Math.round((totalInflowsAll - platformHeldFunds) * 100) / 100),
    totalWithdrawn,
    pendingWithdrawn,
    completedWithdrawn,
     // What Paystack has already deducted from these inflows (1% capped at ₦300
    // per DVA transfer). Already subtracted from availableForWithdrawal.
    estimatedProcessingFees,
    taxReserve,
    fees: feeSchedule(),
    settlementAccount: {
      isConnected: Boolean(business.settlementAccountNumber && business.settlementBankCode),
      bankName: business.settlementBankName,
      bankCode: business.settlementBankCode,
      accountNumber: business.settlementAccountNumber,
      accountName: business.settlementAccountName,
      connectedAt: business.settlementConnectedAt,
    },
    autoSplit: {
      enabled: business.autoSplitEnabled,
      taxSplitPercentage: toNumber(business.taxSplitPercentage),
      subaccountCode: business.paystackSubaccountCode,
    },
    security: {
      hasPin: Boolean(business.user.transactionPin),
      isPinLocked,
      remainingAttempts: isPinLocked ? 0 : Math.max(0, config.pin.maxAttempts - (business.user.pinAttempts || 0)),
    },
    payoutChange: payoutChangeLock,
  };
}

/**
 * Resolves commercial bank account name via Paystack provider
 */
export async function resolveSettlementAccount(params: ResolveSettlementInput) {
  const provider = getPaymentProvider();
  const result = await provider.resolveAccount(params.accountNumber, params.bankCode);
  return {
    bankCode: result.bankCode,
    accountNumber: result.accountNumber,
    accountName: result.accountName,
  };
}

/**
 * Connects commercial settlement bank and provisions split subaccount
 * 
 * Enforces payout account lock:
 * - First connect: no PIN required
 * - Changing existing account: requires admin-granted permission + PIN
 * - Permission expires 24 hours after grant
 * - Updates existing subaccount instead of creating orphans
 */
export async function connectSettlementBank(
  userId: string,
  businessId: string,
  params: ConnectSettlementInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);
  const provider = getPaymentProvider();

  // Import guard at runtime to avoid circular dependency
  const { assertPayoutChangeAllowed } = await import('@/lib/payout-lock');
  
  // Check if this is a change (existing account) or first connect
  const isChange = Boolean(business.settlementAccountNumber);

  // 1. Enforce payout lock for changes (throws 403 if locked or expired)
  if (isChange) {
    assertPayoutChangeAllowed(business);
    
    // 2. Require PIN or step-up token for money-path changes
    if (params.stepUpToken) {
      pinService.verifyStepUpToken(userId, params.stepUpToken);
    } else if (params.pin) {
      await pinService.verifyPin(userId, params.pin);
    } else {
      throw new AppError(
        400,
        'Transaction PIN or step-up authorization token is required to change your payout account',
        'PIN_REQUIRED'
      );
    }
  }

  // 3. Re-resolve server-side (never trust client-supplied name)
  const { accountName } = await provider.resolveAccount(params.accountNumber, params.bankCode);

  let subaccountCode: string;
  let splitAttached = false;

  // 4. Update existing subaccount or create new one
  if (business.paystackSubaccountCode) {
    // Update in place to avoid orphaning the old subaccount
    await provider.updateSubaccount(business.paystackSubaccountCode, {
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
      percentageCharge: config.settlement.platformCommissionPct,
    });
    subaccountCode = business.paystackSubaccountCode;
    
    // Split already attached from previous setup
    splitAttached = Boolean(business.virtualAccountNumber && business.paystackCustomerCode);
  } else {
    // First time — create new subaccount
    const result = await provider.createSubaccount({
      businessName: business.businessName,
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
      percentageCharge: config.settlement.platformCommissionPct,
    });
    subaccountCode = result.subaccountCode;

    // Attach split to existing DVA if active
    if (business.virtualAccountNumber && business.paystackCustomerCode) {
      try {
        await provider.splitDedicatedAccount(business.paystackCustomerCode, subaccountCode);
        splitAttached = true;
      } catch (err) {
        logger.warn('Could not attach split to existing DVA', {
          businessId,
          subaccountCode,
          err: err instanceof Error ? err.message : err,
        });
      }
    }
  }

  // 5. Save account details and consume permission atomically if this was a change
  const updateData: any = {
    paystackSubaccountCode: subaccountCode,
    settlementBankCode: params.bankCode,
    settlementBankName: params.bankName,
    settlementAccountNumber: params.accountNumber,
    settlementAccountName: accountName,
    platformCommissionPct: config.settlement.platformCommissionPct,
    settlementConnectedAt: new Date(),
  };

  // Consume one-shot permission atomically (race-proof)
  if (isChange && business.payoutChangePermitted) {
    updateData.payoutChangePermitted = false;
    updateData.payoutChangeUsedAt = new Date();
  }

  const updatedBusiness = await prisma.business.update({
    where: { id: businessId },
    data: updateData,
  });

  // 6. Audit log
  logAudit({
    userId,
    businessId,
    action: isChange ? 'settlement.account_changed' : 'settlement.connected',
    resourceType: 'business',
    resourceId: businessId,
    oldData: isChange ? {
      bankCode: business.settlementBankCode,
      accountLast4: business.settlementAccountNumber?.slice(-4),
    } : undefined,
    newData: {
      subaccountCode,
      bankCode: params.bankCode,
      accountLast4: params.accountNumber.slice(-4),
      splitAttached,
    },
  });

  return {
    subaccountCode,
    accountName,
    bankName: params.bankName,
    accountNumber: params.accountNumber,
    splitAttached,
  };
}

/**
 * Creates a withdrawal request (NEW-7 v2 admin-approval workflow).
 * No Paystack call on the user path — transfer happens on admin approval.
 * 
 * Triple-fenced against races:
 * 1. Advisory lock (serializes per business)
 * 2. Ledger reservation (pending row deducts from balance)
 * 3. Duplicate guard (same amount within 30 min)
 */
export async function withdrawBalance(
  userId: string,
  businessId: string,
  params: WithdrawBalanceInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // 1. Check if settlement bank account is connected
  if (!business.settlementAccountNumber || !business.settlementBankCode) {
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
  // (crypto-grade, Paystack-safe charset, ≤50 chars)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const transferReference = `PO-${dateStr}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

 // 3b. Price the withdrawal against Paystack's published schedule BEFORE the
  // ledger is touched — the fee decides both what we reserve and what we send.
  // Paystack debits `amount + fee` from the balance, so reserving only the
  // requested amount would leave the platform short on every single payout.
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
    // Fence 1: Advisory lock (transaction-scoped, serializes per business)
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${businessId}::text, 0)) AS locked
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
      throw new AppError(
        400,
        `Insufficient available funds. Maximum withdrawable balance is ₦${preview.availableForWithdrawal.toLocaleString(
          'en-NG',
          { minimumFractionDigits: 2 }
        )}.`,
        'INSUFFICIENT_FUNDS',
        {
          available: preview.availableForWithdrawal,
          requested: params.amount,
          required: quote.amount,
          withdrawalFee: quote.fee,
          taxReserve: preview.taxReserve,
        }
      );
    }

    // Fence 3: Duplicate guard (same amount awaiting approval/transfer within 30 min)
    const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
    const dup = await tx.settlementPayout.findFirst({
      where: {
        businessId,
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
    return tx.settlementPayout.create({
      data: {
        businessId,
        amount: quote.amount,
        fee: quote.fee,
        netAmount: quote.netAmount,
        destinationBankCode: business.settlementBankCode!,
        destinationBankName: business.settlementBankName || 'Commercial Bank',
        destinationAccountNum: business.settlementAccountNumber!,
        destinationAccountName: business.settlementAccountName || business.businessName,
        transferReference,
        status: initialStatus,
        narration: params.narration,
      },
    });
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
        destinationBank: business.settlementBankName,
        accountLast4: business.settlementAccountNumber.slice(-4),
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
 * Toggles gateway auto-split and updates tax split percentage
 */
export async function toggleAutoSplit(
  userId: string,
  businessId: string,
  params: ToggleAutoSplitInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // Enable requires a provisioned subaccount — otherwise no split exists on the
  // DVA and inflows pool 100% on the platform while the UI says "on". (NEW-D)
  // Disabling is always allowed (harmless cleanup of a never-active flag).
  if (params.enabled && !business.paystackSubaccountCode) {
    throw new AppError(
      400,
      'Connect your settlement account first — auto-split needs a provisioned settlement account before it can be enabled.',
      'SETTLEMENT_ACCOUNT_REQUIRED'
    );
  }

  // PIN verification (outside tx)
  if (params.stepUpToken) {
    pinService.verifyStepUpToken(userId, params.stepUpToken);
  } else if (params.pin) {
    await pinService.verifyPin(userId, params.pin);
  } else {
    throw new AppError(400, 'Transaction PIN or step-up authorization token is required', 'PIN_REQUIRED');
  }

  // Percentage clamps (NEW-8)
  let splitPct: number;
  if (params.enabled) {
    splitPct = params.taxSplitPercentage ?? 7.5;
    if (splitPct < config.settlement.minTaxSplitPct || splitPct > config.settlement.maxTaxSplitPct) {
      throw new AppError(
        400,
        `Tax split percentage must be between ${config.settlement.minTaxSplitPct}% and ${config.settlement.maxTaxSplitPct}%`,
        'INVALID_SPLIT_PERCENTAGE'
      );
    }
  } else {
    // Preserve existing percentage setting on disable
    splitPct = toNumber(business.taxSplitPercentage) || 7.5;
  }

  const updatedBusiness = await prisma.business.update({
    where: { id: businessId },
    data: {
      autoSplitEnabled: params.enabled,
      taxSplitPercentage: splitPct,
    },
  });

  // Sync with Paystack subaccount if provisioned
  if (business.paystackSubaccountCode) {
    const provider = getPaymentProvider();
    try {
      await provider.updateSubaccount(business.paystackSubaccountCode, {
        percentageCharge: params.enabled ? splitPct : 0,
      });
    } catch (err) {
      logger.warn('Could not sync subaccount split percentage with Paystack', {
        businessId,
        subaccountCode: business.paystackSubaccountCode,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  logAudit({
    userId,
    businessId,
    action: 'settlement.auto_split_updated',
    resourceType: 'business',
    resourceId: businessId,
    newData: {
      autoSplitEnabled: params.enabled,
      taxSplitPercentage: splitPct,
    },
  });

  return {
    autoSplitEnabled: updatedBusiness.autoSplitEnabled,
    taxSplitPercentage: toNumber(updatedBusiness.taxSplitPercentage),
  };
}

/**
 * Returns paginated payout history for a business
 */
export async function listPayoutHistory(
  userId: string,
  businessId: string,
  query: PayoutHistoryQueryInput
) {
  await verifyBusinessOwnership(userId, businessId);

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



// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Withdrawal Request Management (NEW-7 v2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADMIN: List withdrawal requests (queue) — paginated, optional status filter.
 * Account numbers masked to last-4 in list responses (PII protection).
 */
export async function adminListWithdrawalRequests(query: {
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  search?: string;
  page?: number;
  limit?: number;
}) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  
  const where: any = {};
  if (query.status) {
    where.status = query.status;
  }
  if (query.search && query.search.trim()) {
    const s = query.search.trim();
    where.OR = [
      { business: { businessName: { contains: s, mode: 'insensitive' } } },
      { business: { merchantId: { contains: s, mode: 'insensitive' } } },
      { business: { user: { email: { contains: s, mode: 'insensitive' } } } },
      { destinationAccountName: { contains: s, mode: 'insensitive' } },
      { destinationBankName: { contains: s, mode: 'insensitive' } },
      { transferReference: { contains: s, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.settlementPayout.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        business: {
          select: {
            id: true,
            businessName: true,
            merchantId: true,
            autoPayoutEnabled: true,
            user: {
              select: { id: true, email: true },
            },
          },
        },
      },
    }),
    prisma.settlementPayout.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;
  const now = Date.now();

  return {
    items: items.map((p) => {
      const initiatedTime = p.initiatedAt ? new Date(p.initiatedAt).getTime() : new Date(p.createdAt).getTime();
      const ageHours = (now - initiatedTime) / (1000 * 60 * 60);
      const isStale = p.status === 'pending' && ageHours > 24;

      return {
        id: p.id,
        businessId: p.businessId,
        businessName: p.business.businessName,
        merchantId: p.business.merchantId,
        autoPayoutEnabled: p.business.autoPayoutEnabled,
        userEmail: p.business.user.email,
        amount: toNumber(p.amount),
        fee: toNumber(p.fee),
        netAmount: toNumber(p.netAmount),
        destinationBankName: p.destinationBankName,
        destinationAccountNum: `•••• ${p.destinationAccountNum.slice(-4)}`, // Masked
        destinationAccountName: p.destinationAccountName,
        transferReference: p.transferReference,
        status: p.status,
        isStale,
        narration: p.narration,
        failureReason: p.failureReason,
        adminApprovedBy: p.adminApprovedBy,
        adminApprovedAt: p.adminApprovedAt,
        initiatedAt: p.initiatedAt,
        completedAt: p.completedAt,
        createdAt: p.createdAt,
      };
    }),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

/**
 * ADMIN: Approve a pending withdrawal request → claim → initiate Paystack transfer.
 * 
 * Triple-fenced approval:
 * 1. Advisory lock (serialize approvals per business)
 * 2. Affordability recheck (reserve may have grown since request)
 * 3. Atomic claim (double-approve protection via updateMany WHERE status='pending')
 */
export async function adminApproveWithdrawal(adminUserId: string, payoutId: string) {
  const payout = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
    include: {
      business: {
        include: {
          user: {
            select: { id: true, email: true },
          },
        },
      },
    },
  });

  if (!payout) {
    throw new AppError(404, 'Withdrawal request not found', 'PAYOUT_NOT_FOUND');
  }

  const businessId = payout.businessId;
  const provider = getPaymentProvider();

  // Approval fence: lock + affordability recheck + atomic claim, all in ONE tx
  await prisma.$transaction(async (tx) => {
    // Fence 1: Advisory lock (serialize approvals per business)
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${businessId}::text, 0)) AS locked
    `;
    if (!locked) {
      throw new AppError(
        409,
        'Another approval for this business is in progress. Please wait a moment and try again.',
        'WITHDRAWAL_IN_PROGRESS'
      );
    }

    // Fence 2: Affordability may have changed since request time
    // (another withdrawal approved, or new DVA inflows landed)
    const preview = await getPayoutPreview(
      payout.business.user.id,
      businessId,
      tx,
      { excludePayoutId: payout.id }
    );
    if (toNumber(payout.amount) > preview.availableForWithdrawal) {
      throw new AppError(
        409,
        `Balance no longer covers this request (another withdrawal may have been approved since it was submitted). Reject it and ask the SME to submit a new request.`,
        'INSUFFICIENT_FUNDS_AT_APPROVAL',
        { currentAvailable: preview.availableForWithdrawal, requested: toNumber(payout.amount) }
      );
    }

    // Fence 3: Atomic claim — double-approve killer
    // Only one admin can claim a 'pending' row; second click gets count=0
    const res = await tx.settlementPayout.updateMany({
      where: { id: payout.id, status: 'pending' },
      data: { status: 'processing' },
    });
    if (res.count === 0) {
      throw new AppError(
        409,
        'This request was already approved or rejected by another admin.',
        'ALREADY_PROCESSED'
      );
    }
  }, { maxWait: 10000, timeout: 20000 });

  // Network IO — outside any transaction (house rule: no DB locks during Paystack calls)
  try {
    // Create transfer recipient
    const recipient = await provider.createTransferRecipient({
      type: 'nuban',
      name: payout.destinationAccountName,
      accountNumber: payout.destinationAccountNum,
      bankCode: payout.destinationBankCode,
      currency: 'NGN',
      description: `Payout for ${payout.business.businessName}`,
    });
// Initiate transfer with pre-generated reference (from request time).
    //
    // We send `netAmount`, not `amount`: Paystack debits
    // `netAmount + transferFee + stampDuty` from the balance, which is exactly
    // the `amount` this payout reserved on the ledger. Sending `amount` instead
    // would overdraw the Paystack balance by the fee on every withdrawal.
    // (Legacy rows written before fees were modelled have netAmount === amount,
    // so this stays correct for them too.)
    const transferAmount =
      toNumber(payout.netAmount) > 0 ? toNumber(payout.netAmount) : toNumber(payout.amount);

    // Initiate transfer with pre-generated reference (from request time)
    const transferResult = await provider.initiateTransfer({
      source: 'balance',
      amount: transferAmount,
      recipient: recipient.recipientCode,
      reason: payout.narration || `Balance withdrawal for ${payout.business.businessName}`,
      reference: payout.transferReference,
    });

    const isComplete =
      transferResult.status === 'success' || transferResult.status === 'completed';

    // Update with transfer code (+ completed if immediate success)
    const updated = await prisma.settlementPayout.update({
      where: { id: payout.id },
      data: {
        paystackTransferCode: transferResult.transferCode,
        ...(isComplete ? { status: 'completed', completedAt: new Date() } : {}),
        adminApprovedBy: adminUserId,
        adminApprovedAt: new Date(),
      },
    });

    logAudit({
      userId: adminUserId,
      businessId,
      action: 'settlement.payout_approved',
      resourceType: 'settlement_payout',
      resourceId: payout.id,
      newData: {
        amount: toNumber(payout.amount),
         fee: toNumber(payout.fee),
        netAmount: toNumber(payout.netAmount),
        transferredToBank: transferAmount,
        transferReference: payout.transferReference,
        paystackTransferCode: transferResult.transferCode,
      },
    });

    logger.info('Withdrawal request approved and transfer initiated', {
      payoutId: payout.id,
      businessId,
      amount: toNumber(payout.amount),
       fee: toNumber(payout.fee),
      transferredToBank: transferAmount,
      reference: payout.transferReference,
      adminUserId,
    });

    void createReminderOnce({
      businessId,
      reminderType: 'payout_approved',
      scheduledDate: new Date(),
  message: `Your withdrawal of ${formatNaira(transferAmount)} (ref ${payout.transferReference}) was approved${
        toNumber(payout.fee) > 0
          ? ` after Paystack's ${formatNaira(toNumber(payout.fee))} transfer fee`
          : ''
      }. The transfer to your ${payout.destinationBankName} account ••••${payout.destinationAccountNum.slice(-4)} is in progress.`,
      referenceType: 'settlement_payout',
      referenceId: payout.id,
    }).catch((remErr) =>
      logger.warn('Failed to create payout_approved reminder', {
        payoutId: payout.id,
        err: remErr instanceof Error ? remErr.message : remErr,
      })
    );

    return updated;
  } catch (err) {
    // Release the reservation on Paystack failure
    // (late transfer.success webhook self-heals failed→completed if it actually succeeded)
    try {
      await prisma.settlementPayout.update({
        where: { id: payout.id },
        data: {
          status: 'failed',
          failureReason: err instanceof Error ? err.message : String(err),
        },
      });
      logAudit({
        userId: adminUserId,
        businessId,
        action: 'settlement.payout_failed',
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
        message: `The transfer for your withdrawal of ${formatNaira(toNumber(payout.amount))} could not be initiated; the amount is back in your available balance. Support has been notified.`,
        referenceType: 'settlement_payout',
        referenceId: payout.id,
      }).catch((remErr) =>
        logger.warn('Failed to create payout_failed reminder on approval error', {
          payoutId: payout.id,
          err: remErr instanceof Error ? remErr.message : remErr,
        })
      );
    } catch (markErr) {
      logger.error('Failed to mark payout failed after approval transfer error', {
        payoutId: payout.id,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
    throw err; // Re-throw original Paystack error to admin
  }
}

/**
 * ADMIN: Reject a pending withdrawal request → releases the reserved funds.
 * Conditional update = atomic; only works from 'pending' status.
 */
export async function adminRejectWithdrawal(
  adminUserId: string,
  payoutId: string,
  reason: string
) {
  const payout = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
    select: { id: true, businessId: true, amount: true, status: true },
  });

  if (!payout) {
    throw new AppError(404, 'Withdrawal request not found', 'PAYOUT_NOT_FOUND');
  }

  // Conditional update = atomic claim; reject only works from 'pending'
  const res = await prisma.settlementPayout.updateMany({
    where: { id: payout.id, status: 'pending' },
    data: {
      status: 'failed',
      failureReason: `Rejected by admin: ${reason}`,
    },
  });

  if (res.count === 0) {
    throw new AppError(
      409,
      'This request was already approved or rejected.',
      'ALREADY_PROCESSED'
    );
  }

  logAudit({
    userId: adminUserId,
    businessId: payout.businessId,
    action: 'settlement.payout_rejected',
    resourceType: 'settlement_payout',
    resourceId: payout.id,
    newData: { amount: toNumber(payout.amount), reason },
  });

  logger.info('Withdrawal request rejected by admin', {
    payoutId: payout.id,
    businessId: payout.businessId,
    amount: toNumber(payout.amount),
    reason,
    adminUserId,
  });

  void createReminderOnce({
    businessId: payout.businessId,
    reminderType: 'payout_rejected',
    scheduledDate: new Date(),
    message: `Your withdrawal request of ${formatNaira(toNumber(payout.amount))} was rejected by admin: ${reason}. The funds remain in your available balance.`,
    referenceType: 'settlement_payout',
    referenceId: payout.id,
  }).catch((err) =>
    logger.warn('Failed to create payout_rejected reminder', {
      payoutId: payout.id,
      err: err instanceof Error ? err.message : err,
    })
  );

  return { id: payout.id, status: 'failed' };
}

/**
 * ADMIN: Requery withdrawal status from Paystack (e.g. for stale processing transfers).
 */
export async function adminRequeryWithdrawal(adminUserId: string, payoutId: string) {
  const payout = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
    include: { business: true },
  });

  if (!payout) {
    throw new AppError(404, 'Withdrawal request not found', 'PAYOUT_NOT_FOUND');
  }

  if (payout.status === 'completed') {
    return { id: payout.id, status: payout.status, message: 'Transfer is already marked completed' };
  }

  const provider = getPaymentProvider();
  if (typeof provider.verifyTransfer !== 'function') {
    return { id: payout.id, status: payout.status, message: 'Transfer requery is not supported by payment provider' };
  }

  try {
    const result = await provider.verifyTransfer(payout.transferReference);
    const paystackStatus = result.status?.toLowerCase();

    if (paystackStatus === 'success') {
      await prisma.settlementPayout.update({
        where: { id: payout.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      logAudit({
        userId: adminUserId,
        businessId: payout.businessId,
        action: 'settlement.payout_completed_via_requery',
        resourceType: 'settlement_payout',
        resourceId: payout.id,
        newData: { status: 'completed', transferReference: payout.transferReference },
      });

      return { id: payout.id, status: 'completed', message: 'Transfer verified as successful' };
    } else if (paystackStatus === 'failed' || paystackStatus === 'reversed') {
      await prisma.settlementPayout.update({
        where: { id: payout.id },
        data: {
          status: 'failed',
          failureReason: result.gatewayResponse || 'Transfer failed at bank/Paystack',
        },
      });

      logAudit({
        userId: adminUserId,
        businessId: payout.businessId,
        action: 'settlement.payout_failed_via_requery',
        resourceType: 'settlement_payout',
        resourceId: payout.id,
        newData: { status: 'failed', reason: result.gatewayResponse },
      });

      return { id: payout.id, status: 'failed', message: `Transfer marked failed: ${result.gatewayResponse || paystackStatus}` };
    } else {
      return { id: payout.id, status: payout.status, message: `Transfer is currently ${paystackStatus}` };
    }
  } catch (err: any) {
    logger.warn('Requery transfer error', { payoutId, error: err.message });
    throw new AppError(502, `Failed to verify transfer with Paystack: ${err.message}`, 'PAYSTACK_REQUERY_FAILED');
  }
}

/**
 * Admin: Toggles whether a business's withdrawal requests execute automatically (instant payout)
 * or require manual admin approval (pending review).
 */
export async function adminToggleAutoPayout(
  adminUserId: string,
  businessId: string,
  enabled: boolean
) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      businessName: true,
      autoPayoutEnabled: true,
      settlementAccountNumber: true,
      settlementBankCode: true,
    },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (enabled && (!business.settlementAccountNumber || !business.settlementBankCode)) {
    throw new AppError(
      400,
      'Cannot enable auto-payout for a business without a connected settlement bank account',
      'SETTLEMENT_ACCOUNT_REQUIRED'
    );
  }

  const updated = await prisma.business.update({
    where: { id: businessId },
    data: { autoPayoutEnabled: enabled },
    select: {
      id: true,
      businessName: true,
      autoPayoutEnabled: true,
    },
  });

  logAudit({
    userId: adminUserId,
    businessId,
    action: 'admin.business_auto_payout_toggled',
    resourceType: 'business',
    resourceId: businessId,
    oldData: { autoPayoutEnabled: business.autoPayoutEnabled },
    newData: { autoPayoutEnabled: enabled },
  });

  logger.info('Business auto-payout toggled by admin', {
    businessId,
    businessName: business.businessName,
    adminUserId,
    enabled,
  });

  return updated;
}

