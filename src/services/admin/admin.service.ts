import prisma, { TxClient } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { toNumber } from '@/shared/helpers';
import { transferFee, stampDuty, withdrawalCost, round2 } from '@/lib/paystack-fees';
import { TreasuryAnalyticsFilterInput } from '@/validators/admin.validator';

export async function getDashboardStats() {
  const [totalUsers, totalBusinesses, totalTaxReports, recentSignups] =
    await Promise.all([
      prisma.user.count(),
      prisma.business.count(),
      prisma.monthlyTaxReport.count(),
      prisma.user.findMany({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
        select: {
          id: true,
          email: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

  const [revenueResult, pendingWithdrawals] = await Promise.all([
    prisma.monthlyTaxReport.aggregate({
      _sum: { totalSales: true },
    }),
    prisma.settlementPayout.findMany({
      where: { status: 'pending' },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const now = Date.now();
  const breachedWithdrawals = pendingWithdrawals.filter(
    (w) => (now - w.createdAt.getTime()) > 24 * 60 * 60 * 1000
  );
  const oldestPendingHours = pendingWithdrawals.length > 0
    ? Math.round((now - pendingWithdrawals[0].createdAt.getTime()) / (1000 * 60 * 60))
    : 0;

  return {
    totalUsers,
    totalBusinesses,
    totalTaxReports,
    totalRevenueProcessed: revenueResult._sum.totalSales ?? 0,
    recentSignups,
    withdrawalSla: {
      pendingCount: pendingWithdrawals.length,
      breachedCount: breachedWithdrawals.length,
      oldestPendingHours,
    },
  };
}

export async function listUsers(page: number, limit: number, search?: string) {
  const where = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        isVerified: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { businesses: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: users,
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

export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      phone: true,
      role: true,
      isVerified: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      businesses: {
        select: {
          id: true,
          businessName: true,
          ownerName: true,
          taxId: true,
          businessType: true,
          state: true,
          city: true,
          createdAt: true,
        },
      },
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  return user;
}

export async function toggleUserStatus(userId: string, isActive: boolean, adminId?: string, tx?: TxClient) {
  const db = tx ?? prisma;

  const user = await db.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (user.role === 'admin') {
    throw new AppError(400, 'Cannot change status of an admin user', 'CANNOT_MODIFY_ADMIN');
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: { isActive },
    select: {
      id: true,
      email: true,
      isActive: true,
    },
  });

  await logAudit({
    userId: adminId,
    action: isActive ? 'admin.user_activated' : 'admin.user_deactivated',
    resourceType: 'user',
    resourceId: userId,
    oldData: { isActive: user.isActive },
    newData: { isActive },
  }, tx);

  return updated;
}

export async function verifyUserEmail(userId: string, adminId?: string, tx?: TxClient) {
  const db = tx ?? prisma;

  const user = await db.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (user.isVerified) {
    // Already verified - return current state (idempotent)
    return {
      id: user.id,
      email: user.email,
      isVerified: true,
    };
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: { isVerified: true },
    select: {
      id: true,
      email: true,
      isVerified: true,
    },
  });

  await logAudit({
    userId: adminId,
    action: 'admin.user_email_verified',
    resourceType: 'user',
    resourceId: userId,
    oldData: { isVerified: false },
    newData: { isVerified: true },
  }, tx);

  return updated;
}

export async function unverifyUserEmail(userId: string, adminId?: string, tx?: TxClient) {
  const db = tx ?? prisma;

  const user = await db.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (!user.isVerified) {
    // Already unverified - return current state (idempotent)
    return {
      id: user.id,
      email: user.email,
      isVerified: false,
    };
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: { isVerified: false },
    select: {
      id: true,
      email: true,
      isVerified: true,
    },
  });

  await logAudit({
    userId: adminId,
    action: 'admin.user_email_unverified',
    resourceType: 'user',
    resourceId: userId,
    oldData: { isVerified: true },
    newData: { isVerified: false },
  }, tx);

  return updated;
}

export async function listAllBusinesses(page: number, limit: number) {
  const [businesses, total] = await Promise.all([
    prisma.business.findMany({
      select: {
        id: true,
        businessName: true,
        ownerName: true,
        taxId: true,
        businessType: true,
        state: true,
        city: true,
        createdAt: true,
        user: {
          select: { id: true, email: true },
        },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.business.count(),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: businesses,
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

export async function listAuditLogs(
  page: number,
  limit: number,
  filters?: { userId?: string; action?: string }
) {
  const where: any = {};
  if (filters?.userId) where.userId = filters.userId;
  if (filters?.action) where.action = filters.action;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, email: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: logs,
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
 * Grants one-time payout account change permission (24h expiry)
 * 
 * Idempotent: re-grant refreshes timestamp
 */
export async function grantPayoutChangePermission(
  businessId: string,
  adminId: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      businessName: true,
      settlementAccountNumber: true,
      userId: true,
    },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (!business.settlementAccountNumber) {
    throw new AppError(
      400,
      'No payout account connected yet. Nothing to lock or unlock.',
      'NO_PAYOUT_ACCOUNT'
    );
  }

  const now = new Date();
  const updatedBusiness = await db.business.update({
    where: { id: businessId },
    data: {
      payoutChangePermitted: true,
      payoutChangePermittedAt: now,
      payoutChangePermittedBy: adminId,
      // Clear used timestamp if re-granting after a previous use
      payoutChangeUsedAt: null,
    },
    select: {
      id: true,
      businessName: true,
      payoutChangePermitted: true,
      payoutChangePermittedAt: true,
      payoutChangePermittedBy: true,
    },
  });

  await logAudit({
    userId: adminId,
    businessId,
    action: 'admin.payout_change_permitted',
    resourceType: 'business',
    resourceId: businessId,
    newData: {
      permitted: true,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    },
  }, tx);

  // Fire reminder notification (post-transaction, fire-and-forget)
  if (!tx) {
    // Only fire outside transaction to avoid blocking
    const { createReminderOnce } = await import('@/services/reminder.service');
    createReminderOnce({
      businessId,
      reminderType: 'payout_change_permitted',
      scheduledDate: now,
      referenceType: 'business',
      referenceId: businessId,
      updateMessageOnDup: true,
      message: 'Support approved a one-time payout account change. You can update it now from Account → Payout settings. This permission expires in 24 hours.',
    }).catch((err) => {
      // Fire-and-forget — log but don't fail the grant
      const logger = require('@/lib/logger').default;
      logger.error('Failed to create payout permission reminder', {
        businessId,
        err: err instanceof Error ? err.message : err,
      });
    });
  }

  return updatedBusiness;
}

/**
 * Revokes an unused payout change permission
 */
export async function revokePayoutChangePermission(
  businessId: string,
  adminId: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      businessName: true,
      payoutChangePermitted: true,
      payoutChangeUsedAt: true,
    },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (!business.payoutChangePermitted) {
    // Already revoked or never granted — idempotent
    return {
      id: business.id,
      businessName: business.businessName,
      payoutChangePermitted: false,
    };
  }

  if (business.payoutChangeUsedAt) {
    throw new AppError(
      400,
      'Permission was already consumed. Cannot revoke.',
      'PERMISSION_ALREADY_USED'
    );
  }

  const updatedBusiness = await db.business.update({
    where: { id: businessId },
    data: {
      payoutChangePermitted: false,
      payoutChangePermittedAt: null,
      payoutChangePermittedBy: null,
    },
    select: {
      id: true,
      businessName: true,
      payoutChangePermitted: true,
    },
  });

  await logAudit({
    userId: adminId,
    businessId,
    action: 'admin.payout_change_permit_revoked',
    resourceType: 'business',
    resourceId: businessId,
    oldData: { permitted: true },
    newData: { permitted: false },
  }, tx);

  return updatedBusiness;
}

export async function getTreasuryAnalytics(filters: TreasuryAnalyticsFilterInput) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;

  // 1. Fetch settled DVA inflows
  const dvaSales = await prisma.salesTransaction.findMany({
    where: {
      source: 'bank_transfer',
      dvaOrigin: true,
      status: { in: ['confirmed', 'completed'] },
    },
    include: {
      business: { select: { id: true, businessName: true } },
    },
    orderBy: { transactionDate: 'desc' },
  });

  // 2. Fetch all completed, processing, or pending payouts
  const payouts = await prisma.settlementPayout.findMany({
    where: {
      status: { in: ['completed', 'processing', 'pending'] },
    },
    include: {
      business: { select: { id: true, businessName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // 3. Compute aggregate KPIs
  let totalGrossInflows = 0;
  let totalInflowFeesAbsorbed = 0;
  for (const sale of dvaSales) {
    const gross = toNumber(sale.amount);
    const feeAbsorbed = Math.min(round2(gross * 0.01), 300);
    totalGrossInflows += gross;
    totalInflowFeesAbsorbed += feeAbsorbed;
  }

  let totalGrossOutflows = 0;
  let totalWithdrawalFeesCollected = 0;
  let totalDisbursementCost = 0;
  for (const payout of payouts) {
    const totalDebit = toNumber(payout.amount);
    const feeCollected = toNumber(payout.fee);
    const netDisbursed = toNumber(payout.netAmount) > 0 ? toNumber(payout.netAmount) : Math.max(0, totalDebit - feeCollected);
    const cost = payout.status === 'pending' ? 0 : withdrawalCost(netDisbursed);
    totalGrossOutflows += netDisbursed;
    totalWithdrawalFeesCollected += feeCollected;
    totalDisbursementCost += cost;
  }

  totalGrossInflows = round2(totalGrossInflows);
  totalInflowFeesAbsorbed = round2(totalInflowFeesAbsorbed);
  totalGrossOutflows = round2(totalGrossOutflows);
  totalWithdrawalFeesCollected = round2(totalWithdrawalFeesCollected);
  totalDisbursementCost = round2(totalDisbursementCost);

  const netPlatformMargin = round2(
    totalWithdrawalFeesCollected - totalInflowFeesAbsorbed - totalDisbursementCost
  );

  // 4. Map both into unified transfer margin items
  const allTransfers: Array<{
    id: string;
    date: string;
    type: 'inflow' | 'outflow';
    businessId: string;
    businessName: string;
    reference: string;
    status: string;
    grossAmount: number;
    feeCollected: number;
    gatewayCost: number;
    netMargin: number;
  }> = [];

  for (const sale of dvaSales) {
    const gross = toNumber(sale.amount);
    const cost = Math.min(round2(gross * 0.01), 300);
    allTransfers.push({
      id: sale.id,
      date: sale.transactionDate.toISOString(),
      type: 'inflow',
      businessId: sale.businessId,
      businessName: sale.business?.businessName || 'Unknown Business',
      reference: sale.referenceId || sale.id.slice(0, 8),
      status: sale.status,
      grossAmount: gross,
      feeCollected: 0,
      gatewayCost: cost,
      netMargin: -cost, // Absorbed cost represented as negative margin
    });
  }

  for (const payout of payouts) {
    const totalDebit = toNumber(payout.amount);
    const feeCollected = toNumber(payout.fee);
    const netDisbursed = toNumber(payout.netAmount) > 0 ? toNumber(payout.netAmount) : Math.max(0, totalDebit - feeCollected);
    const cost = payout.status === 'pending' ? 0 : withdrawalCost(netDisbursed);
    const netMargin = round2(feeCollected - cost);
    allTransfers.push({
      id: payout.id,
      date: payout.createdAt.toISOString(),
      type: 'outflow',
      businessId: payout.businessId,
      businessName: payout.business?.businessName || 'Unknown Business',
      reference: payout.transferReference,
      status: payout.status,
      grossAmount: netDisbursed,
      feeCollected,
      gatewayCost: cost,
      netMargin,
    });
  }

  // 5. Apply filters
  let filtered = allTransfers;
  if (filters.type && filters.type !== 'all') {
    filtered = filtered.filter((t) => t.type === filters.type);
  }

  if (filters.outcome === 'profit') {
    filtered = filtered.filter((t) => t.netMargin > 0);
  } else if (filters.outcome === 'loss') {
    filtered = filtered.filter((t) => t.netMargin < 0);
  }

  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter(
      (t) =>
        t.reference.toLowerCase().includes(q) ||
        t.businessName.toLowerCase().includes(q)
    );
  }

  // Sort by date descending
  filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // 6. Paginate
  const total = filtered.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const startIndex = (page - 1) * limit;
  const paginatedItems = filtered.slice(startIndex, startIndex + limit);

  return {
    kpis: {
      totalGrossInflows,
      totalInflowFeesAbsorbed,
      totalGrossOutflows,
      totalWithdrawalFeesCollected,
      totalDisbursementCost,
      netPlatformMargin,
      isProfitable: netPlatformMargin >= 0,
    },
    transfers: paginatedItems,
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

export async function getTreasuryTransactionDetail(id: string, type?: 'inflow' | 'outflow') {
  if (type === 'inflow' || (!type && id.length > 0)) {
    const sale = await prisma.salesTransaction.findUnique({
      where: { id },
      include: {
        business: {
          include: {
            user: {
              select: { id: true, email: true, phone: true },
            },
          },
        },
      },
    });

    if (sale) {
      const gross = toNumber(sale.amount);
      const paystackFee = Math.min(round2(gross * 0.01), 300);
      return {
        id: sale.id,
        type: 'inflow' as const,
        reference: sale.referenceId || sale.id,
        date: sale.transactionDate,
        createdAt: sale.createdAt,
        status: sale.status,
        business: {
          id: sale.businessId,
          name: sale.business?.businessName || 'Unknown Business',
          owner: sale.business?.ownerName || 'N/A',
          email: sale.business?.user?.email || 'N/A',
        },
        financials: {
          grossAmount: gross,
          customerCredit: gross, // 100% credited
          platformFeeCollected: 0,
          paystackInflowFeeAbsorbed: paystackFee,
          federalStampDuty: 0,
          totalGatewayCost: paystackFee,
          netMargin: -paystackFee,
          isProfit: false,
        },
        routing: {
          channel: 'Dedicated Virtual Account (DVA)',
          provider: 'Paystack',
          customerName: sale.customerName || 'N/A',
          description: sale.description || 'Auto-captured DVA bank transfer',
        },
      };
    }
  }

  // Check SettlementPayout
  const payout = await prisma.settlementPayout.findUnique({
    where: { id },
    include: {
      business: {
        include: {
          user: {
            select: { id: true, email: true, phone: true },
          },
        },
      },
    },
  });

  if (!payout) {
    throw new AppError(404, 'Transaction not found in treasury records', 'TRANSACTION_NOT_FOUND');
  }

  const totalDebit = toNumber(payout.amount);
  const withdrawalFee = toNumber(payout.fee);
  const disbursed = toNumber(payout.netAmount) > 0 ? toNumber(payout.netAmount) : Math.max(0, totalDebit - withdrawalFee);
  const paystackFee = payout.status === 'pending' ? 0 : transferFee(disbursed);
  const duty = payout.status === 'pending' ? 0 : stampDuty(disbursed);
  const totalCost = round2(paystackFee + duty);
  const netMargin = round2(withdrawalFee - totalCost);

  return {
    id: payout.id,
    type: 'outflow' as const,
    reference: payout.transferReference,
    date: payout.createdAt,
    completedAt: payout.completedAt,
    status: payout.status,
    business: {
      id: payout.businessId,
      name: payout.business?.businessName || 'Unknown Business',
      owner: payout.business?.ownerName || 'N/A',
      email: payout.business?.user?.email || 'N/A',
    },
    financials: {
      grossAmount: disbursed,
      customerDebit: totalDebit,
      amountDisbursed: disbursed,
      platformFeeCollected: withdrawalFee,
      paystackTransferFee: paystackFee,
      federalStampDuty: duty,
      totalGatewayCost: totalCost,
      netMargin,
      isProfit: netMargin >= 0,
    },
    routing: {
      channel: 'Commercial Bank Transfer',
      destinationBank: payout.destinationBankName,
      destinationBankCode: payout.destinationBankCode,
      destinationAccountNum: payout.destinationAccountNum,
      destinationAccountName: payout.destinationAccountName,
      paystackTransferCode: payout.paystackTransferCode,
      adminApprovedBy: payout.adminApprovedBy,
      adminApprovedAt: payout.adminApprovedAt,
      narration: payout.narration,
      failureReason: payout.failureReason,
    },
  };
}

