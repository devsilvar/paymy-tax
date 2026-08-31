import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { CreateSaleInput, UpdateSaleInput, SalesOverviewQueryInput } from '@/validators/sales.validator';
import { verifyBusinessOwnership } from '@/lib/ownership';


// ─── Helpers ────────────────────────────────────────────────

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
      // Canonical settled status — matches the tax engine, verification, and
      // the DB reality (all settled rows are 'confirmed').
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
        // Settled statuses only — include both the canonical 'confirmed' and
        // the legacy 'completed' so the summary matches the tax engine.
        status: { in: ['confirmed', 'completed'] },
      },
      _sum: { amount: true },
    }),

    // Breakdown by source
    prisma.salesTransaction.groupBy({
      by: ['source'],
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
        status: { in: ['confirmed', 'completed'] },
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

// ─── Financial Timeline & Overview ───────────────────────────

function toNumber(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  if (typeof (val as any).toNumber === 'function') return (val as any).toNumber();
  return Number(val) || 0;
}

function pctDelta(curr: number, prior: number): number | null {
  if (prior === 0) return curr === 0 ? 0 : null;
  return parseFloat((((curr - prior) / prior) * 100).toFixed(2));
}

function formatDateIso(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatMonthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatMonthLabel(d: Date): string {
  return d.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatDayLabel(d: Date): string {
  const day = d.getUTCDate();
  const month = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${day} ${month}`;
}

function parseDateOnly(str: string): Date {
  const parts = str.split('-').map(Number);
  if (parts.length === 2) {
    return new Date(Date.UTC(parts[0], parts[1] - 1, 1));
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] ?? 1));
}

export interface SalesOverviewTimelinePoint {
  date: string;
  label: string;
  sales: number;
  expenses: number;
  netProfit: number;
  profitMargin: number;
  salesCount: number;
  expensesCount: number;
}

export interface SalesOverviewResponse {
  period: {
    key: string;
    from: string;
    to: string;
    granularity: 'day' | 'month';
  };
  kpis: {
    totalSales: number;
    totalExpenses: number;
    netProfit: number;
    profitMargin: number;
    salesCount: number;
    expensesCount: number;
    deltas: {
      salesPct: number | null;
      expensesPct: number | null;
      netProfitPct: number | null;
    };
  };
  timeline: SalesOverviewTimelinePoint[];
  breakdown: {
    salesBySource: Array<{ source: string; amount: number; percentage: number }>;
    expensesByCategory: Array<{ category: string; amount: number; percentage: number }>;
  };
}

export async function getSalesAndExpensesOverview(
  userId: string,
  businessId: string,
  query: SalesOverviewQueryInput
): Promise<SalesOverviewResponse> {
  await verifyBusinessOwnership(userId, businessId);

  const now = new Date();
  const periodKey = query.period || '12m';

  let from: Date;
  let to: Date;
  let prevFrom: Date | null = null;
  let prevTo: Date | null = null;
  let granularity: 'day' | 'month' = 'month';

  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const curMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const curMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  switch (periodKey) {
    case '7d': {
      granularity = 'day';
      to = todayEnd;
      from = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(from.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case '30d': {
      granularity = 'day';
      to = todayEnd;
      from = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(from.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
    case '3m': {
      granularity = 'month';
      to = curMonthEnd;
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1, 0, 0, 0, 0));
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1, 0, 0, 0, 0));
      break;
    }
    case '6m': {
      granularity = 'month';
      to = curMonthEnd;
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1, 0, 0, 0, 0));
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1, 0, 0, 0, 0));
      break;
    }
    case '12m': {
      granularity = 'month';
      to = curMonthEnd;
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1, 0, 0, 0, 0));
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1, 0, 0, 0, 0));
      break;
    }
    case 'ytd': {
      granularity = now.getUTCMonth() === 0 ? 'day' : 'month';
      to = todayEnd;
      from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
      prevFrom = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0));
      prevTo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
      break;
    }
    case 'all': {
      granularity = 'month';
      to = curMonthEnd;
      const [earliestSale, earliestExpense] = await Promise.all([
        prisma.salesTransaction.findFirst({
          // 'confirmed' is the canonical settled status (import/DVA/invoice-paid
          // rows); 'completed' is the legacy manual-entry status. Count both,
          // exclude pending/reversed/disputed.
          where: { businessId, status: { in: ['confirmed', 'completed'] }, isTaxable: true },
          orderBy: { transactionDate: 'asc' },
          select: { transactionDate: true },
        }),
        prisma.expense.findFirst({
          where: { businessId, isDeductible: true },
          orderBy: { expenseDate: 'asc' },
          select: { expenseDate: true },
        }),
      ]);

      const earliestDate = [earliestSale?.transactionDate, earliestExpense?.expenseDate]
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => a.getTime() - b.getTime())[0];

      if (earliestDate) {
        const floor = new Date(Date.UTC(now.getUTCFullYear() - 5, now.getUTCMonth(), 1));
        const rawFrom = new Date(Date.UTC(earliestDate.getUTCFullYear(), earliestDate.getUTCMonth(), 1));
        from = rawFrom < floor ? floor : rawFrom;
      } else {
        from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
      }
      break;
    }
    case 'custom': {
      if (!query.from || !query.to) {
        throw new AppError(400, 'Custom range requires both "from" and "to" parameters', 'RANGE_INCOMPLETE');
      }
      from = parseDateOnly(query.from);
      to = parseDateOnly(query.to);
      to = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 23, 59, 59, 999));
      if (from > to) {
        throw new AppError(400, '"from" date must be earlier than or equal to "to" date', 'RANGE_INVERTED');
      }

      const diffDays = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
      if (query.granularity && query.granularity !== 'auto') {
        granularity = query.granularity;
      } else {
        granularity = diffDays <= 62 ? 'day' : 'month';
      }

      const durationMs = to.getTime() - from.getTime();
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(from.getTime() - durationMs);
      break;
    }
    default: {
      granularity = 'month';
      to = curMonthEnd;
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    }
  }

  // Parallel data fetching
  const [currentSales, currentExpenses, prevSalesAgg, prevExpensesAgg] = await Promise.all([
    prisma.salesTransaction.findMany({
      where: {
        businessId,
        // 'confirmed' is the canonical settled status (import/DVA/invoice-paid
        // rows); 'completed' is the legacy manual-entry status. Counting only
        // 'completed' here made the dashboard chart exclude most real sales
        // (the Sales page list has no status filter, hence the mismatch).
        status: { in: ['confirmed', 'completed'] },
        isTaxable: true,
        transactionDate: { gte: from, lte: to },
      },
      select: {
        amount: true,
        source: true,
        transactionDate: true,
      },
    }),
    prisma.expense.findMany({
      where: {
        businessId,
        isDeductible: true,
        expenseDate: { gte: from, lte: to },
      },
      select: {
        amount: true,
        category: true,
        expenseDate: true,
      },
    }),
    prevFrom && prevTo
      ? prisma.salesTransaction.aggregate({
          where: {
            businessId,
            status: { in: ['confirmed', 'completed'] },
            isTaxable: true,
            transactionDate: { gte: prevFrom, lte: prevTo },
          },
          _sum: { amount: true },
        })
      : Promise.resolve({ _sum: { amount: null } }),
    prevFrom && prevTo
      ? prisma.expense.aggregate({
          where: {
            businessId,
            isDeductible: true,
            expenseDate: { gte: prevFrom, lte: prevTo },
          },
          _sum: { amount: true },
        })
      : Promise.resolve({ _sum: { amount: null } }),
  ]);

  // Construct continuous timeline with gap-filling
  const timelineMap = new Map<string, SalesOverviewTimelinePoint>();

  if (granularity === 'day') {
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const endCursor = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
    while (cursor <= endCursor) {
      const key = formatDateIso(cursor);
      timelineMap.set(key, {
        date: key,
        label: formatDayLabel(cursor),
        sales: 0,
        expenses: 0,
        netProfit: 0,
        profitMargin: 0,
        salesCount: 0,
        expensesCount: 0,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else {
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const endCursor = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    while (cursor <= endCursor) {
      const key = formatMonthKey(cursor);
      timelineMap.set(key, {
        date: key,
        label: formatMonthLabel(cursor),
        sales: 0,
        expenses: 0,
        netProfit: 0,
        profitMargin: 0,
        salesCount: 0,
        expensesCount: 0,
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  // Populate sales
  const salesBySourceMap = new Map<string, number>();
  let totalSales = 0;
  let salesCount = 0;

  for (const s of currentSales) {
    const amt = toNumber(s.amount);
    totalSales += amt;
    salesCount += 1;

    const source = s.source || 'other';
    salesBySourceMap.set(source, (salesBySourceMap.get(source) || 0) + amt);

    const key = granularity === 'day' ? formatDateIso(s.transactionDate) : formatMonthKey(s.transactionDate);
    const bucket = timelineMap.get(key);
    if (bucket) {
      bucket.sales += amt;
      bucket.salesCount += 1;
    }
  }

  // Populate expenses
  const expensesByCategoryMap = new Map<string, number>();
  let totalExpenses = 0;
  let expensesCount = 0;

  for (const e of currentExpenses) {
    const amt = toNumber(e.amount);
    totalExpenses += amt;
    expensesCount += 1;

    const cat = e.category || 'general';
    expensesByCategoryMap.set(cat, (expensesByCategoryMap.get(cat) || 0) + amt);

    const key = granularity === 'day' ? formatDateIso(e.expenseDate) : formatMonthKey(e.expenseDate);
    const bucket = timelineMap.get(key);
    if (bucket) {
      bucket.expenses += amt;
      bucket.expensesCount += 1;
    }
  }

  // Calculate Net Profit and Profit Margin for each timeline point
  for (const bucket of timelineMap.values()) {
    bucket.sales = parseFloat(bucket.sales.toFixed(2));
    bucket.expenses = parseFloat(bucket.expenses.toFixed(2));
    bucket.netProfit = parseFloat((bucket.sales - bucket.expenses).toFixed(2));
    bucket.profitMargin = bucket.sales > 0
      ? parseFloat(((bucket.netProfit / bucket.sales) * 100).toFixed(2))
      : 0;
  }

  const timeline = Array.from(timelineMap.values());

  // Compute breakdown percentages
  const salesBySource = Array.from(salesBySourceMap.entries())
    .map(([source, amount]) => ({
      source,
      amount: parseFloat(amount.toFixed(2)),
      percentage: totalSales > 0 ? parseFloat(((amount / totalSales) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const expensesByCategory = Array.from(expensesByCategoryMap.entries())
    .map(([category, amount]) => ({
      category,
      amount: parseFloat(amount.toFixed(2)),
      percentage: totalExpenses > 0 ? parseFloat(((amount / totalExpenses) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Compute overall KPIs and deltas
  const netProfit = totalSales - totalExpenses;
  const profitMargin = totalSales > 0 ? parseFloat(((netProfit / totalSales) * 100).toFixed(2)) : 0;

  const prevSales = toNumber(prevSalesAgg._sum.amount);
  const prevExpenses = toNumber(prevExpensesAgg._sum.amount);
  const prevNetProfit = prevSales - prevExpenses;

  const deltas = {
    salesPct: prevFrom ? pctDelta(totalSales, prevSales) : null,
    expensesPct: prevFrom ? pctDelta(totalExpenses, prevExpenses) : null,
    netProfitPct: prevFrom ? pctDelta(netProfit, prevNetProfit) : null,
  };

  return {
    period: {
      key: periodKey,
      from: formatDateIso(from),
      to: formatDateIso(to),
      granularity,
    },
    kpis: {
      totalSales: parseFloat(totalSales.toFixed(2)),
      totalExpenses: parseFloat(totalExpenses.toFixed(2)),
      netProfit: parseFloat(netProfit.toFixed(2)),
      profitMargin,
      salesCount,
      expensesCount,
      deltas,
    },
    timeline,
    breakdown: {
      salesBySource,
      expensesByCategory,
    },
  };
}

