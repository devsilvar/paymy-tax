import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { CreateSaleInput, UpdateSaleInput } from '@/validators/sales.validator';

// ─── Helpers ────────────────────────────────────────────────

/**
 * Verify business exists and belongs to the user.
 * Reused across every operation to enforce ownership.
 */
async function verifyBusinessOwnership(
  userId: string,
  businessId: string,
  db: TxClient | typeof prisma = prisma
) {
  const business = await db.business.findUnique({ where: { id: businessId } });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  return business;
}

/**
 * Check if the month containing `transactionDate` is locked.
 * A locked month means a tax report has been paid — no edits allowed.
 */
async function assertMonthNotLocked(
  businessId: string,
  transactionDate: Date,
  db: TxClient | typeof prisma = prisma
) {
  // UTC — must match calculateTax's UTC taxMonth so the unique-key lookup
  // hits. transactionDate is itself @db.Date (already UTC on read), so we
  // derive year/month in UTC and rebuild the first-of-month in UTC.
  const monthStart = new Date(
    Date.UTC(transactionDate.getUTCFullYear(), transactionDate.getUTCMonth(), 1)
  );

  const report = await db.monthlyTaxReport.findUnique({
    where: {
      businessId_taxMonth: {
        businessId,
        taxMonth: monthStart,
      },
    },
    select: { isLocked: true, isFinalized: true },
  });

  if (report?.isLocked) {
    throw new AppError(
      423,
      'This month is locked — tax has been paid. No edits allowed.',
      'PERIOD_LOCKED'
    );
  }

  if (report?.isFinalized) {
    throw new AppError(
      423,
      'This month is finalized. Un-finalize it before editing sales.',
      'PERIOD_FINALIZED'
    );
  }
}

// ─── CRUD ───────────────────────────────────────────────────

export async function createSale(
  userId: string,
  businessId: string,
  input: CreateSaleInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);
  await assertMonthNotLocked(businessId, input.transactionDate, db);

  const sale = await db.salesTransaction.create({
    data: {
      businessId,
      amount: input.amount,
      source: input.source,
      status: input.status ?? 'confirmed',
      referenceId: input.referenceId,
      description: input.description,
      customerName: input.customerName,
      transactionDate: input.transactionDate,
      metadata: input.metadata !== undefined ? input.metadata : undefined,
      needsVerification: input.needsVerification ?? false,
      createdBy: userId,
    },
  });

  logAudit({
    userId,
    businessId,
    action: 'sale.created',
    resourceType: 'sales_transaction',
    resourceId: sale.id,
    newData: { amount: input.amount, source: input.source },
  }, tx);

  logger.info('Sale created', { saleId: sale.id, businessId, userId });

  return sale;
}

export async function listSales(
  userId: string,
  businessId: string,
  query: {
    page: number;
    limit: number;
    source?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    month?: number;
    year?: number;
  }
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };

  if (query.source) where.source = query.source;
  if (query.status) where.status = query.status;

  // Date range filter
  if (query.startDate || query.endDate) {
    where.transactionDate = {};
    if (query.startDate) where.transactionDate.gte = query.startDate;
    if (query.endDate) where.transactionDate.lte = query.endDate;
  }

  // Month/year filter — takes precedence over date range
  if (query.month && query.year) {
    const monthStart = new Date(query.year, query.month - 1, 1);
    const monthEnd = new Date(query.year, query.month, 0); // last day of month
    where.transactionDate = { gte: monthStart, lte: monthEnd };
  }

  const offset = (query.page - 1) * query.limit;

  const [sales, total] = await Promise.all([
    prisma.salesTransaction.findMany({
      where,
      skip: offset,
      take: query.limit,
      // Secondary sort by createdAt so bulk imports sharing a transactionDate
      // surface newest-first instead of in arbitrary Postgres order.
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.salesTransaction.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: sales,
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

export async function getSaleById(userId: string, businessId: string, saleId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const sale = await prisma.salesTransaction.findUnique({
    where: { id: saleId },
  });

  if (!sale || sale.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  return sale;
}

export async function updateSale(
  userId: string,
  businessId: string,
  saleId: string,
  input: UpdateSaleInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const existing = await db.salesTransaction.findUnique({ where: { id: saleId } });

  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  // Check lock on the EXISTING transaction date (can't edit a sale in a locked month)
  await assertMonthNotLocked(businessId, existing.transactionDate, db);

  // If the transaction date is changing, also check the NEW month isn't locked
  if (input.transactionDate && input.transactionDate.getTime() !== existing.transactionDate.getTime()) {
    await assertMonthNotLocked(businessId, input.transactionDate, db);
  }

  const data: Record<string, any> = {};
  if (input.amount !== undefined) data.amount = input.amount;
  if (input.source !== undefined) data.source = input.source;
  if (input.status !== undefined) data.status = input.status;
  if (input.referenceId !== undefined) data.referenceId = input.referenceId;
  if (input.description !== undefined) data.description = input.description;
  if (input.customerName !== undefined) data.customerName = input.customerName;
  if (input.transactionDate !== undefined) data.transactionDate = input.transactionDate;
  if (input.metadata !== undefined) data.metadata = input.metadata;

  const updated = await db.salesTransaction.update({
    where: { id: saleId },
    data,
  });

  logAudit({
    userId,
    businessId,
    action: 'sale.updated',
    resourceType: 'sales_transaction',
    resourceId: saleId,
    oldData: { amount: Number(existing.amount), source: existing.source },
    newData: input as Record<string, any>,
  }, tx);

  logger.info('Sale updated', { saleId, businessId, userId });

  return updated;
}

export async function deleteSale(
  userId: string,
  businessId: string,
  saleId: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const existing = await db.salesTransaction.findUnique({ where: { id: saleId } });

  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  await assertMonthNotLocked(businessId, existing.transactionDate, db);

  await db.salesTransaction.delete({
    where: { id: saleId },
  });

  logAudit({
    userId,
    businessId,
    action: 'sale.deleted',
    resourceType: 'sales_transaction',
    resourceId: saleId,
    oldData: { amount: Number(existing.amount), source: existing.source, description: existing.description },
  }, tx);

  logger.info('Sale deleted', { saleId, businessId, userId });

  return { message: 'Sale deleted successfully' };
}

// ─── Summary ────────────────────────────────────────────────

export async function getMonthlySummary(
  userId: string,
  businessId: string,
  month: number,
  year: number
) {
  await verifyBusinessOwnership(userId, businessId);

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0); // last day of month

  const [aggregation, bySource, count] = await Promise.all([
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
        status: 'confirmed', // only confirmed sales count toward tax
      },
      _sum: { amount: true },
    }),

    // Breakdown by source
    prisma.salesTransaction.groupBy({
      by: ['source'],
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
        status: 'confirmed',
      },
      _sum: { amount: true },
      _count: true,
    }),

    prisma.salesTransaction.count({
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
      },
    }),
  ]);

  const totalSales = aggregation._sum.amount ?? 0;

  const sourceBreakdown = bySource.map((entry) => ({
    source: entry.source,
    total: entry._sum.amount ?? 0,
    count: entry._count,
  }));

  return {
    month,
    year,
    totalSales,
    transactionCount: count,
    sourceBreakdown,
  };
}

// ─── Verification ───────────────────────────────────────────

export async function getUnverifiedSales(
  userId: string,
  businessId: string,
  query?: { page?: number; limit?: number }
) {
  await verifyBusinessOwnership(userId, businessId);

  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  const offset = (page - 1) * limit;

  const [sales, total] = await Promise.all([
    prisma.salesTransaction.findMany({
      where: { businessId, needsVerification: true },
      skip: offset,
      take: limit,
      orderBy: { transactionDate: 'desc' },
    }),
    prisma.salesTransaction.count({
      where: { businessId, needsVerification: true },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: sales,
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

export async function verifySale(
  userId: string,
  businessId: string,
  saleId: string,
  classificationName: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const sale = await db.salesTransaction.findUnique({ where: { id: saleId } });

  if (!sale || sale.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  if (!sale.needsVerification) {
    throw new AppError(400, 'Sale is already verified', 'ALREADY_VERIFIED');
  }

  // Find classification
  const classification = await db.transactionClassification.findFirst({
    where: {
      OR: [
        { name: classificationName },
        { name: { equals: classificationName, mode: 'insensitive' } },
      ],
      isActive: true,
    },
  });

  if (!classification) {
    throw new AppError(400, `Classification "${classificationName}" not found`, 'INVALID_CLASSIFICATION');
  }

  // Determine if taxable based on classification
  const isTaxable = classification.taxTreatment === 'taxable';
  const isRevenue = classification.isRevenue;

  const updated = await db.salesTransaction.update({
    where: { id: saleId },
    data: {
      needsVerification: false,
      verifiedAt: new Date(),
      verifiedBy: userId,
      finalClassification: classificationName,
      classificationId: classification.id,
      status: 'confirmed', // Always confirm when verified
      isTaxable,
    },
  });

  logAudit({
    userId,
    businessId,
    action: isRevenue ? 'sale.verified' : 'sale.reclassified',
    resourceType: 'sales_transaction',
    resourceId: saleId,
    newData: {
      classification: classificationName,
      category: classification.category,
      isTaxable,
      isRevenue,
    },
  }, tx);

  logger.info('Transaction classified', {
    saleId,
    businessId,
    userId,
    classification: classificationName,
    category: classification.category,
    isTaxable,
    isRevenue,
  });

  return updated;
}

export async function reclassifySale(
  userId: string,
  businessId: string,
  saleId: string,
  classificationName: string,
  tx?: TxClient
) {
  // Reclassify is now just an alias to verify with any classification
  return verifySale(userId, businessId, saleId, classificationName, tx);
}
