import prisma, { TxClient } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';

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

  const revenueResult = await prisma.monthlyTaxReport.aggregate({
    _sum: { totalSales: true },
  });

  return {
    totalUsers,
    totalBusinesses,
    totalTaxReports,
    totalRevenueProcessed: revenueResult._sum.totalSales ?? 0,
    recentSignups,
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

  logAudit({
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

  logAudit({
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

  logAudit({
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

  logAudit({
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

  logAudit({
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
