import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { getPaymentProvider } from '@/lib/payment';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import * as pinService from '@/services/pin.service';
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

  // 1. Total confirmed DVA inflows
  // DVA-originated inflows only — matches getDVABalance (dva.service.ts:363-367).
  // Manually-entered bank transfers never touched the platform balance and
  // MUST NOT be withdrawable. (noticepay.md NEW-B)
  const inflowsAggregate = await db.salesTransaction.aggregate({
    where: {
      businessId,
      source: 'bank_transfer',
      status: 'confirmed',
      metadata: { path: ['channel'], equals: 'dva' },
    },
    _sum: {
      amount: true,
    },
  });
  const totalInflows = toNumber(inflowsAggregate._sum.amount ?? 0);

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

  // If no finalized reports yet, compute 7.5% tax escrow reserve on total sales minus expenses
  if (unpaidReports.length === 0 && totalInflows > 0) {
    const totalExpensesAgg = await db.expense.aggregate({
      where: { businessId, isDeductible: true },
      _sum: { amount: true },
    });
    const totalExpenses = toNumber(totalExpensesAgg._sum.amount ?? 0);
    const grossProfit = Math.max(0, totalInflows - totalExpenses);
    estimatedTaxLiability = Math.round(grossProfit * 0.075 * 100) / 100;
  }

  // 4. Safe available balance (cannot withdraw funds reserved for unpaid FIRS taxes)
  const taxReserve = Math.max(0, estimatedTaxLiability);
  const availableForWithdrawal = Math.max(0, Math.round((totalInflows - totalWithdrawn - taxReserve) * 100) / 100);

  const isPinLocked = Boolean(
    business.user.pinLockedUntil && business.user.pinLockedUntil > new Date()
  );

  // Import lock status helper
  const { getPayoutLockStatus } = await import('@/lib/payout-lock');
  const payoutChangeLock = getPayoutLockStatus(business);

  return {
    businessId: business.id,
    businessName: business.businessName,
    totalInflows,
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
      remainingAttempts: isPinLocked ? 0 : Math.max(0, 3 - (business.user.pinAttempts || 0)),
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
    
    // 2. Require PIN step-up for money-path changes
    if (!params.pin) {
      throw new AppError(
        400,
        'Transaction PIN is required to change your payout account',
        'PIN_REQUIRED'
      );
    }
    await pinService.verifyPin(userId, params.pin);
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
      percentageCharge: params.commissionPct ?? 0,
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
      percentageCharge: params.commissionPct ?? 0,
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
    platformCommissionPct: params.commissionPct ?? 0,
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

  // 2. Verify 4-digit transaction PIN (with lockout protection & bcrypt outside DB tx)
  await pinService.verifyPin(userId, params.pin);

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
  });

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

  const updatedBusiness = await prisma.business.update({
    where: { id: businessId },
    data: {
      autoSplitEnabled: params.enabled,
      taxSplitPercentage: params.taxSplitPercentage ?? 7.5,
    },
  });

  // Sync with Paystack subaccount if provisioned
  if (business.paystackSubaccountCode) {
    const provider = getPaymentProvider();
    try {
      await provider.updateSubaccount(business.paystackSubaccountCode, {
        percentageCharge: params.enabled ? params.taxSplitPercentage ?? 7.5 : 0,
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
      taxSplitPercentage: params.taxSplitPercentage ?? 7.5,
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

  return {
    items: items.map((p) => ({
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
      narration: p.narration,
      failureReason: p.failureReason,
      initiatedAt: p.initiatedAt,
      completedAt: p.completedAt,
      createdAt: p.createdAt,
    })),
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
      data: { status: 'processing' },
    });
    if (res.count === 0) {
      throw new AppError(
        409,
        'This request was already approved or rejected by another admin.',
        'ALREADY_PROCESSED'
      );
    }
  });

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

    // Initiate transfer with pre-generated reference (from request time)
    const transferResult = await provider.initiateTransfer({
      source: 'balance',
      amount: toNumber(payout.amount),
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
      },
    });

    logger.info('Withdrawal request approved and transfer initiated', {
      payoutId: payout.id,
      businessId,
      amount: toNumber(payout.amount),
      reference: payout.transferReference,
      adminUserId,
    });

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

  // Optional (recommended, NEW-I-adjacent): notify SME with reason
  // const { createReminderOnce } = await import('@/services/reminder.service');
  // await createReminderOnce({ ... });

  return { id: payout.id, status: 'failed' };
}
