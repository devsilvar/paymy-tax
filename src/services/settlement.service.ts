import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { getPaymentProvider } from '@/lib/payment';
import type { PaymentProvider } from '@/lib/payment/types';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import * as pinService from '@/services/pin.service';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';
import config from '@/config';
import crypto from 'crypto';
import {
  WithdrawBalanceInput,
  ToggleAutoSplitInput,
  PayoutHistoryQueryInput,
  ConnectSettlementInput,
  ResolveSettlementInput,
} from '@/validators/settlement.validator';

/**
 * Helper to resolve Paystack transfer recipient code.
 * Reuses stored code ONLY if the stored recipientFingerprint matches the
 * destinationBankCode:destinationAccountNum snapshot of the approved payout.
 */
async function resolveRecipientCode(
  provider: PaymentProvider,
  payout: {
    destinationBankCode: string;
    destinationAccountNum: string;
    destinationAccountName: string;
    businessId: string;
    businessName: string;
  },
  stored: { paystackRecipientCode?: string | null; recipientFingerprint?: string | null },
): Promise<{ recipientCode: string; reused: boolean }> {
  // Fingerprint of the account THIS payout is destined for (the approved snapshot)
  const fingerprint = `${payout.destinationBankCode}:${payout.destinationAccountNum}`;

  // Reuse ONLY when the stored code was provably built for this exact destination
  if (stored.paystackRecipientCode && stored.recipientFingerprint === fingerprint) {
    return { recipientCode: stored.paystackRecipientCode, reused: true }; // fast path — zero Paystack calls
  }

  const { recipientCode } = await provider.createTransferRecipient({
    type: 'nuban',
    name: payout.destinationAccountName,
    accountNumber: payout.destinationAccountNum,
    bankCode: payout.destinationBankCode,
    currency: 'NGN',
    description: `Payout for ${payout.businessName}`,
  });

  await prisma.business.update({
    where: { id: payout.businessId },
    data: { paystackRecipientCode: recipientCode, recipientFingerprint: fingerprint },
  });
  return { recipientCode, reused: false };
}

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
 * Computes available withdrawal balance, tax escrow reserve, and settlement details.
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

  // 4. Safe available balance (cannot withdraw funds reserved for unpaid FIRS taxes)
  const taxReserve = Math.max(0, estimatedTaxLiability);
  const availableForWithdrawal = Math.max(0, Math.round((platformHeldFunds - totalWithdrawn - taxReserve) * 100) / 100);

  const isPinLocked = Boolean(
    business.user.pinLockedUntil && business.user.pinLockedUntil > new Date()
  );

  // Import lock status helper
  const { getPayoutLockStatus } = await import('@/lib/payout-lock');
  const payoutChangeLock = getPayoutLockStatus(business);

  return {
    businessId: business.id,
    businessName: business.businessName,
    totalInflows: totalInflowsAll,
    totalSplitSettled: Math.max(0, Math.round((totalInflowsAll - platformHeldFunds) * 100) / 100),
    totalWithdrawn,
    taxReserve,
    availableForWithdrawal,
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
    
    // 2. Require PIN step-up or authorization token for money-path changes
    await pinService.assertTransactionAuthorization(userId, params);
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

  // 2. Verify transaction authorization (PIN or step-up token with lockout protection & bcrypt outside DB tx)
  await pinService.assertTransactionAuthorization(userId, params);

  // 3. Generate unique transfer reference BEFORE the transaction
  // (crypto-grade, Paystack-safe charset, ≤50 chars)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const transferReference = `PO-${dateStr}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

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
    if (params.amount > preview.availableForWithdrawal) {
      throw new AppError(
        400,
        `Insufficient available funds. Maximum withdrawable balance is ₦${preview.availableForWithdrawal.toLocaleString(
          'en-NG',
          { minimumFractionDigits: 2 }
        )} (₦${preview.taxReserve.toLocaleString('en-NG', {
          minimumFractionDigits: 2,
        })} is reserved for unpaid FIRS tax liabilities).`,
        'INSUFFICIENT_FUNDS',
        {
          available: preview.availableForWithdrawal,
          requested: params.amount,
          taxReserve: preview.taxReserve,
        }
      );
    }

    // Fence 3: Duplicate guard (same amount awaiting approval/transfer within 30 min)
    // → almost certainly a double-tap mistake
    const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
    const dup = await tx.settlementPayout.findFirst({
      where: {
        businessId,
        amount: params.amount,
        status: { in: ['pending', 'processing'] },
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { id: true, transferReference: true },
    });
    if (dup) {
      throw new AppError(
        409,
        'You already have a withdrawal request for this exact amount that is awaiting approval. Check its status or wait for it to be processed before requesting again.',
        'DUPLICATE_WITHDRAWAL_REQUEST',
        { existingRequestId: dup.id, existingReference: dup.transferReference }
      );
    }

    // Ledger-first: the pending row IS the reservation (awaiting admin approval)
    // No Paystack call — transfer happens on admin approval (adminApproveWithdrawal)
    return tx.settlementPayout.create({
      data: {
        businessId,
        amount: params.amount,
        fee: 0,
        netAmount: params.amount,
        destinationBankCode: business.settlementBankCode,
        destinationBankName: business.settlementBankName || 'Commercial Bank',
        destinationAccountNum: business.settlementAccountNumber,
        destinationAccountName: business.settlementAccountName || business.businessName,
        transferReference,
        status: 'pending', // = awaiting admin approval
        narration: params.narration,
      },
    });
  }, { maxWait: 10000, timeout: 20000 });

  // Audit log (fire-and-forget, outside tx)
  logAudit({
    userId,
    businessId,
    action: 'settlement.payout_requested',
    resourceType: 'settlement_payout',
    resourceId: payout.id,
    newData: {
      amount: params.amount,
      transferReference,
      destinationBank: business.settlementBankName,
      accountLast4: business.settlementAccountNumber.slice(-4),
    },
  });

  logger.info('Withdrawal request submitted (awaiting admin approval)', {
    businessId,
    payoutId: payout.id,
    amount: params.amount,
    reference: transferReference,
  });

  void createReminderOnce({
    businessId,
    reminderType: 'payout_requested',
    scheduledDate: new Date(),
    message: `Withdrawal request of ${formatNaira(params.amount)} received (ref ${transferReference}). We'll notify you once it's reviewed — usually within 1–2 business hours.`,
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
    transferReference: payout.transferReference,
    status: payout.status, // 'pending'
    destinationBankName: payout.destinationBankName,
    destinationAccountNum: payout.destinationAccountNum,
    destinationAccountName: payout.destinationAccountName,
    initiatedAt: payout.initiatedAt,
    completedAt: payout.completedAt,
    message: 'Withdrawal request submitted. It will be processed once approved by an admin.',
  };
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

  // PIN or step-up token verification (outside tx)
  await pinService.assertTransactionAuthorization(userId, params);

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
  page?: number;
  limit?: number;
}) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  
  const where: any = {};
  if (query.status) {
    where.status = query.status;
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
  const staleHours = config.settlement.payoutStaleHours ?? 24;
  const staleThreshold = new Date(Date.now() - staleHours * 60 * 60 * 1000);

  const mapped = items.map((p) => ({
    id: p.id,
    businessId: p.businessId,
    businessName: p.business.businessName,
    merchantId: p.business.merchantId,
    userEmail: p.business.user.email,
    amount: toNumber(p.amount),
    destinationBankName: p.destinationBankName,
    destinationAccountNum: `•••• ${p.destinationAccountNum.slice(-4)}`, // Masked
    destinationAccountName: p.destinationAccountName,
    transferReference: p.transferReference,
    status: p.status,
    isStale: p.status === 'processing' && p.initiatedAt < staleThreshold,
    narration: p.narration,
    failureReason: p.failureReason,
    initiatedAt: p.initiatedAt,
    completedAt: p.completedAt,
    createdAt: p.createdAt,
  }));

  return {
    data: mapped,
    items: mapped,
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
    // (new unpaid tax report → bigger reserve)
    const preview = await getPayoutPreview(
      payout.business.user.id,
      businessId,
      tx,
      { excludePayoutId: payout.id }
    );
    if (toNumber(payout.amount) > preview.availableForWithdrawal) {
      throw new AppError(
        409,
        `Balance no longer covers this request (tax reserve may have increased from ₦${preview.taxReserve.toLocaleString('en-NG')}). Reject it and ask the SME to submit a new request.`,
        'INSUFFICIENT_FUNDS_AT_APPROVAL',
        { currentAvailable: preview.availableForWithdrawal, requested: toNumber(payout.amount) }
      );
    }

    // Fence 3: Atomic claim — double-approve killer
    // Only one admin can claim a 'pending' row; second click gets count=0
    const res = await tx.settlementPayout.updateMany({
      where: { id: payout.id, status: 'pending' },
      data: { status: 'processing', initiatedAt: new Date() },
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
    // Resolve transfer recipient (reuse existing if unchanged, create new if changed/first time)
    const { recipientCode, reused } = await resolveRecipientCode(
      provider,
      {
        destinationBankCode: payout.destinationBankCode,
        destinationAccountNum: payout.destinationAccountNum,
        destinationAccountName: payout.destinationAccountName,
        businessId: payout.businessId,
        businessName: payout.business.businessName,
      },
      payout.business
    );

    // Initiate transfer with pre-generated reference (from request time)
    const transferResult = await provider.initiateTransfer({
      source: 'balance',
      amount: toNumber(payout.amount),
      recipient: recipientCode,
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
        transferReference: payout.transferReference,
        paystackTransferCode: transferResult.transferCode,
        recipientReused: reused,
      },
    });

    logger.info('Withdrawal request approved and transfer initiated', {
      payoutId: payout.id,
      businessId,
      amount: toNumber(payout.amount),
      reference: payout.transferReference,
      recipientReused: reused,
      adminUserId,
    });

    void createReminderOnce({
      businessId,
      reminderType: 'payout_approved',
      scheduledDate: new Date(),
      message: `Your withdrawal of ${formatNaira(toNumber(payout.amount))} (ref ${payout.transferReference}) was approved. The transfer to your ${payout.destinationBankName} account ••••${payout.destinationAccountNum.slice(-4)} is in progress.`,
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
    // Failure self-heal: if error is recipient-related, clear stored recipient on business
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.toLowerCase().includes('recipient')) {
      logger.warn('Clearing stored recipient code on business due to recipient error', {
        businessId,
        error: errorMsg,
      });
      await prisma.business.update({
        where: { id: businessId },
        data: { paystackRecipientCode: null, recipientFingerprint: null },
      }).catch((clearErr) => {
        logger.warn('Failed to clear invalid recipient code on business', { businessId, clearErr });
      });
    }

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
 * Shared outcome applier for payout transfers (webhooks + stale sweep + manual requery).
 * 
 * Guard semantics:
 * - success: updates status from 'processing' or 'failed' to 'completed' (preserves self-heal on late success webhook)
 * - failed: updates status from 'processing' to 'failed' (prevents regressing 'completed' payouts)
 * - no-op: if 0 rows updated, logs warning and skips reminder
 */
export async function applyTransferOutcome(
  payoutId: string,
  outcome: 'success' | 'failed',
  failureReason?: string,
  meta?: { reference?: string; transferCode?: string }
): Promise<{ applied: boolean; payout: any }> {
  const payout = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
    include: { business: true },
  });

  if (!payout) {
    logger.warn('applyTransferOutcome: payout not found', { payoutId, outcome });
    return { applied: false, payout: null };
  }

  const ref = meta?.reference || payout.transferReference;
  const transferCode = meta?.transferCode || payout.paystackTransferCode;

  if (outcome === 'success') {
    const res = await prisma.settlementPayout.updateMany({
      where: {
        id: payoutId,
        status: { in: ['processing', 'failed'] },
      },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    if (res.count === 0) {
      logger.warn('applyTransferOutcome: guarded success update matched 0 rows (already terminal or completed)', {
        payoutId,
        currentStatus: payout.status,
      });
      return { applied: false, payout };
    }

    logAudit({
      businessId: payout.businessId,
      action: 'settlement.payout_completed',
      resourceType: 'settlement_payout',
      resourceId: payout.id,
      newData: { reference: ref, transferCode },
    });

    logger.info('Settlement payout marked completed', {
      payoutId: payout.id,
      reference: ref,
    });

    void createReminderOnce({
      businessId: payout.businessId,
      reminderType: 'payout_completed',
      scheduledDate: new Date(),
      message: `Your withdrawal of ${formatNaira(toNumber(payout.amount))} (ref ${ref || payout.transferReference}) was successfully transferred to your ${payout.destinationBankName} account.`,
      referenceType: 'settlement_payout',
      referenceId: payout.id,
    }).catch((err) =>
      logger.warn('Failed to create payout_completed reminder', {
        payoutId: payout.id,
        err: err instanceof Error ? err.message : err,
      })
    );

    return { applied: true, payout };
  } else {
    const reason = failureReason || 'Transfer could not be completed';
    const res = await prisma.settlementPayout.updateMany({
      where: {
        id: payoutId,
        status: 'processing',
      },
      data: {
        status: 'failed',
        failureReason: reason,
      },
    });

    if (res.count === 0) {
      logger.warn('applyTransferOutcome: guarded failure update matched 0 rows (already terminal or not in processing)', {
        payoutId,
        currentStatus: payout.status,
      });
      return { applied: false, payout };
    }

    logAudit({
      businessId: payout.businessId,
      action: 'settlement.payout_failed',
      resourceType: 'settlement_payout',
      resourceId: payout.id,
      newData: { reference: ref, transferCode, reason },
    });

    logger.info('Settlement payout marked failed', {
      payoutId: payout.id,
      reference: ref,
      reason,
    });

    void createReminderOnce({
      businessId: payout.businessId,
      reminderType: 'payout_failed',
      scheduledDate: new Date(),
      message: `Your withdrawal transfer of ${formatNaira(toNumber(payout.amount))} (ref ${ref || payout.transferReference}) failed: ${reason}. The funds remain available in your balance.`,
      referenceType: 'settlement_payout',
      referenceId: payout.id,
    }).catch((err) =>
      logger.warn('Failed to create payout_failed reminder', {
        payoutId: payout.id,
        err: err instanceof Error ? err.message : err,
      })
    );

    return { applied: true, payout };
  }
}

/**
 * Daily sweep of stale 'processing' payouts.
 * Runs in node-cron inside Postgres advisory lock.
 */
export async function sweepStalePayouts(): Promise<{
  checked: number;
  completed: number;
  failed: number;
  stillPending: number;
}> {
  const staleHours = config.settlement.payoutStaleHours ?? 24;
  const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

  const stalePayouts = await prisma.settlementPayout.findMany({
    where: {
      status: 'processing',
      initiatedAt: { lt: cutoff },
    },
  });

  const provider = getPaymentProvider();
  let completed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const payout of stalePayouts) {
    try {
      const verifyRes = await provider.verifyTransfer(payout.transferReference);
      if (verifyRes.status === 'success') {
        const { applied } = await applyTransferOutcome(payout.id, 'success');
        if (applied) completed++;
      } else if (verifyRes.status === 'failed' || verifyRes.status === 'reversed') {
        const reason = verifyRes.failureReason || 'Bank transfer failed or was reversed';
        const { applied } = await applyTransferOutcome(payout.id, 'failed', reason);
        if (applied) failed++;
      } else {
        // 'otp' or 'pending'
        stillPending++;
        logger.info('Stale payout verification still pending at provider', {
          payoutId: payout.id,
          reference: payout.transferReference,
          status: verifyRes.status,
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.toLowerCase().includes('not found') || (err as any)?.statusCode === 404) {
        logger.warn('Stale payout transfer not found at provider — marking failed', {
          payoutId: payout.id,
          reference: payout.transferReference,
        });
        const { applied } = await applyTransferOutcome(
          payout.id,
          'failed',
          'Transfer not found at provider — initiation never completed'
        );
        if (applied) failed++;
      } else {
        logger.warn('Failed to verify stale payout transfer', {
          payoutId: payout.id,
          reference: payout.transferReference,
          error: errMsg,
        });
        stillPending++;
      }
    }
  }

  return {
    checked: stalePayouts.length,
    completed,
    failed,
    stillPending,
  };
}

/**
 * ADMIN: Manually re-query a processing withdrawal request against Paystack.
 */
export async function adminRequeryWithdrawal(adminUserId: string, payoutId: string) {
  const payout = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
    include: { business: true },
  });

  if (!payout) {
    throw new AppError(404, 'Withdrawal request not found', 'PAYOUT_NOT_FOUND');
  }

  if (payout.status !== 'processing') {
    throw new AppError(
      409,
      `Cannot re-query payout with status '${payout.status}'. Only 'processing' payouts can be re-queried.`,
      'PAYOUT_NOT_PROCESSABLE'
    );
  }

  const provider = getPaymentProvider();
  let outcomeStatus: string = 'pending';
  let message: string = 'Transfer is still pending at Paystack.';

  try {
    const verifyRes = await provider.verifyTransfer(payout.transferReference);
    outcomeStatus = verifyRes.status;

    if (verifyRes.status === 'success') {
      await applyTransferOutcome(payout.id, 'success');
      message = 'Transfer verified as completed.';
    } else if (verifyRes.status === 'failed' || verifyRes.status === 'reversed') {
      const reason = verifyRes.failureReason || 'Bank transfer failed or was reversed';
      await applyTransferOutcome(payout.id, 'failed', reason);
      message = `Transfer failed: ${reason}`;
    } else if (verifyRes.status === 'otp') {
      message = 'Transfer is awaiting OTP resolution at Paystack.';
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.toLowerCase().includes('not found') || (err as any)?.statusCode === 404) {
      outcomeStatus = 'failed';
      const reason = 'Transfer not found at provider — initiation never completed';
      await applyTransferOutcome(payout.id, 'failed', reason);
      message = `Transfer marked failed: ${reason}`;
    } else {
      throw new AppError(502, `Failed to re-query Paystack: ${errMsg}`, 'PAYSTACK_ERROR');
    }
  }

  logAudit({
    userId: adminUserId,
    businessId: payout.businessId,
    action: 'settlement.payout_requeried',
    resourceType: 'settlement_payout',
    resourceId: payout.id,
    newData: {
      transferReference: payout.transferReference,
      outcomeStatus,
      message,
    },
  });

  const updated = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
  });

  return {
    payout: updated,
    outcomeStatus,
    message,
  };
}

