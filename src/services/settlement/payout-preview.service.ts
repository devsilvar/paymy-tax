import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
  dvaFeeCapThreshold,
  dvaFeeTotalFromBuckets,
  feeSchedule,
} from '@/lib/paystack-fees';
import config from '@/config';
import {
  toNumber,
  getWithdrawalActor,
  SETTLED_SALE_STATUSES,
} from '@/shared/helpers';
import { getPayoutLockStatus } from '@/lib/payout-lock';

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
  const business = await getWithdrawalActor(userId, businessId, tx);
  const db = tx ?? prisma;

  // 1. DVA Inflows breakdown:
  // DVA-originated inflows only — matches getDVABalance (dva.service.ts:363-367).
  // Centralized Banking: Because the DVA and Paystack balance are centralized at the User level
  // (1 human = 1 BVN = 1 DVA), total withdrawable wallet funds reflect the user's pooled DVA
  // balance across all their businesses, while sales and tax remain strictly compartmentalized.
  const userBizRecords = await db.business.findMany({
    where: { userId },
    select: { id: true },
  });
  const userBizIds = userBizRecords.length > 0 ? userBizRecords.map((b) => b.id) : [businessId];

  // Platform-held share of split-settled inflows.
  // Settled-status rule: DVA inflows are created 'pending' and flipped to
  // 'confirmed' on verification — they are NEVER 'completed'. Counting only
  // 'completed' zeroed out platform-held funds. 'confirmed' is canonical;
  // 'completed' kept for legacy rows. Matches getDVABalance + e2e test NEW-B.
  const splitAgg = await db.salesTransaction.aggregate({
    where: {
      businessId: { in: userBizIds },
      source: 'bank_transfer',
      dvaOrigin: true,
      status: { in: SETTLED_SALE_STATUSES },
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
      businessId: { in: userBizIds },
      source: 'bank_transfer',
      dvaOrigin: true,
      status: { in: SETTLED_SALE_STATUSES },
      settledViaSplit: false,
    },
    _sum: {
      amount: true,
    },
  });
  const totalPlainInflows = toNumber(plainAgg._sum.amount ?? 0);

  // ALL settled DVA inflows across user's businesses (for central user vault cash)
  const allAgg = await db.salesTransaction.aggregate({
    where: {
      businessId: { in: userBizIds },
      source: 'bank_transfer',
      dvaOrigin: true,
      status: { in: SETTLED_SALE_STATUSES },
    },
    _sum: {
      amount: true,
    },
  });
  const totalInflowsAll = toNumber(allAgg._sum.amount ?? 0);
  const platformHeldFunds = totalPlainInflows + totalPlatformRetained;

  // Active business's own settled DVA inflows (strictly for this business's ledger & tax)
  const businessAgg = await db.salesTransaction.aggregate({
    where: {
      businessId,
      source: 'bank_transfer',
      dvaOrigin: true,
      status: { in: SETTLED_SALE_STATUSES },
    },
    _sum: {
      amount: true,
    },
  });
  const businessInflows = toNumber(businessAgg._sum.amount ?? 0);

  // 1b. Processing fees Paystack has ALREADY taken on those inflows.
  let estimatedProcessingFees = 0;
  const capThreshold = dvaFeeCapThreshold();
  if (Number.isFinite(capThreshold)) {
    const dvaBase: Prisma.SalesTransactionWhereInput = {
      businessId: { in: userBizIds },
      source: 'bank_transfer',
      dvaOrigin: true,
      status: { in: SETTLED_SALE_STATUSES },
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

  // 2. Total completed / pending / processing withdrawals across user's businesses
  const payoutsWhere: any = {
    businessId: { in: userBizIds },
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
      where: { businessId: { in: userBizIds }, status: 'completed' },
      _sum: { amount: true },
    }),
    db.settlementPayout.aggregate({
      where: { businessId: { in: userBizIds }, status: { in: ['pending', 'processing'] } },
      _sum: { amount: true },
    }),
  ]);
  const completedWithdrawn = toNumber(completedAggregate._sum.amount ?? 0);
  const pendingWithdrawn = toNumber(pendingAggregate._sum.amount ?? 0);

  // Active business's own completed/pending withdrawals (strictly for this business's outflow tracking)
  const [bizCompletedAggregate, bizPendingAggregate] = await Promise.all([
    db.settlementPayout.aggregate({
      where: { businessId, status: 'completed' },
      _sum: { amount: true },
    }),
    db.settlementPayout.aggregate({
      where: { businessId, status: { in: ['pending', 'processing'] } },
      _sum: { amount: true },
    }),
  ]);
  const bizCompletedWithdrawn = toNumber(bizCompletedAggregate._sum.amount ?? 0);
  const bizPendingWithdrawn = toNumber(bizPendingAggregate._sum.amount ?? 0);
  const bizTotalWithdrawn = bizCompletedWithdrawn + bizPendingWithdrawn;

  // 3. Tax Liability calculation (unpaid reports or estimated monthly liability)
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
  if (unpaidReports.length === 0 && businessInflows > 0) {
    const totalExpensesAgg = await db.expense.aggregate({
      where: { businessId, isDeductible: true },
      _sum: { amount: true },
    });
    const totalExpenses = toNumber(totalExpensesAgg._sum.amount ?? 0);
    const grossProfit = Math.max(0, businessInflows - totalExpenses);
    estimatedTaxLiability = Math.round(grossProfit * 0.075 * 100) / 100;
  }

  // 4. Tax due (display-only) and available balance.
  const taxReserve = Math.max(0, estimatedTaxLiability);

  // Available balance: Platform-held DVA funds minus already taken Paystack DVA processing fees minus total withdrawals.
  const availableForWithdrawal = Math.max(
    0,
    Math.round(
      (platformHeldFunds - estimatedProcessingFees - totalWithdrawn) * 100
    ) / 100
  );

  const isPinLocked = Boolean(
    business.user.pinLockedUntil && business.user.pinLockedUntil > new Date()
  );

  const payoutChangeLock = getPayoutLockStatus(business);

  return {
    businessId: business.id,
    businessName: business.businessName,
    walletBalance: availableForWithdrawal,
    availableForWithdrawal,
    totalInflows: businessInflows,
    businessInflows,
    pooledInflows: totalInflowsAll,
    totalSplitSettled: Math.max(0, Math.round((totalInflowsAll - platformHeldFunds) * 100) / 100),
    totalWithdrawn: bizTotalWithdrawn,
    businessWithdrawn: bizTotalWithdrawn,
    pooledTotalWithdrawn: totalWithdrawn,
    pendingWithdrawn: bizPendingWithdrawn,
    pooledPendingWithdrawn: pendingWithdrawn,
    completedWithdrawn: bizCompletedWithdrawn,
    pooledCompletedWithdrawn: completedWithdrawn,
    estimatedProcessingFees,
    taxReserve,
    fees: feeSchedule(),
    settlementAccount: {
      isConnected: Boolean(
        (business.settlementAccountNumber || business.user.settlementAccountNumber) &&
        (business.settlementBankCode || business.user.settlementBankCode)
      ),
      bankName: business.settlementBankName || business.user.settlementBankName,
      bankCode: business.settlementBankCode || business.user.settlementBankCode,
      accountNumber: business.settlementAccountNumber || business.user.settlementAccountNumber,
      accountName: business.settlementAccountName || business.user.settlementAccountName,
      connectedAt: business.settlementConnectedAt || business.user.settlementConnectedAt,
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
