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
