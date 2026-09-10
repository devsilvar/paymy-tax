import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { AppError } from '@/middleware/errorHandler';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { toNumber, SETTLED_SALE_STATUSES, TAXABLE_SALES_WHERE } from '@/shared/helpers';
import { SalesOverviewQueryInput } from '@/validators/sales.validator';

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

  const [aggregation, taxableAggregation, bySource, count] = await Promise.all([
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
        // Settled statuses only — include both the canonical 'confirmed' and
        // the legacy 'completed'
        status: { in: SETTLED_SALE_STATUSES },
      },
      _sum: { amount: true },
    }),

    // Taxable settled sales — aligns directly with tax engine calculations
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
        ...TAXABLE_SALES_WHERE,
      },
      _sum: { amount: true },
    }),

    // Breakdown by source
    prisma.salesTransaction.groupBy({
      by: ['source'],
      where: {
        businessId,
        transactionDate: { gte: monthStart, lte: monthEnd },
        status: { in: SETTLED_SALE_STATUSES },
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
  const taxableSales = taxableAggregation._sum.amount ?? 0;

  const sourceBreakdown = bySource.map((entry) => ({
    source: entry.source,
    total: entry._sum.amount ?? 0,
    count: entry._count,
  }));

  return {
    month,
    year,
    totalSales,
    taxableSales,
    transactionCount: count,
    sourceBreakdown,
  };
}

// ─── Daily Summary ──────────────────────────────────────────

/**
 * Same-day totals grouped by payment type (source) + the day's register rows.
 *
 * Day boundaries are UTC midnight → 23:59:59.999 — deliberately identical to
 * getSalesAndExpensesOverview (see `todayStart/todayEnd` above) and
 * getMonthlySummary, so Σ(daily boxes over a month) always reconciles with
 * the monthly total. No isTaxable filter (matches getMonthlySummary, NOT
 * /overview — see salesexpense.md §3.3).
 */
export async function getDailySummary(
  userId: string,
  businessId: string,
  date?: string
) {
  await verifyBusinessOwnership(userId, businessId);

  const day = date ?? new Date().toISOString().slice(0, 10);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime())) {
    throw new AppError(400, 'Invalid date — expected YYYY-MM-DD', 'INVALID_DATE');
  }
  // String compare is safe on zero-padded YYYY-MM-DD. "Today" is allowed;
  // anything past tomorrow (UTC) is rejected so future-dated boxes can't lie.
  const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (day > tomorrowStr) {
    throw new AppError(
      400,
      'Date cannot be more than a day in the future',
      'INVALID_DATE'
    );
  }

  const settledWhere: Prisma.SalesTransactionWhereInput = {
    businessId,
    transactionDate: { gte: dayStart, lte: dayEnd },
    // Settled statuses only — same rule as getMonthlySummary ('confirmed'
    // is canonical, 'completed' is legacy). See SALES_SUMMARY_API_FIX.md.
    status: { in: SETTLED_SALE_STATUSES },
  };

  const [aggregation, bySource, transactions] = await Promise.all([
    prisma.salesTransaction.aggregate({
      where: settledWhere,
      _sum: { amount: true },
    }),

    // Breakdown by payment type — mirrors the monthly summary's shape so the
    // frontend shares one type + one mapping (labels live in the UI layer).
    prisma.salesTransaction.groupBy({
      by: ['source'],
      where: settledWhere,
      _sum: { amount: true },
      _count: true,
    }),

    // Register: every row dated today (any status) so pending/reversed
    // entries are visible too — capped to keep the payload bounded.
    prisma.salesTransaction.findMany({
      where: { businessId, transactionDate: { gte: dayStart, lte: dayEnd } },
      orderBy: { transactionDate: 'desc' },
      take: 200,
      select: {
        id: true,
        amount: true,
        source: true,
        status: true,
        description: true,
        customerName: true,
        transactionDate: true,
        referenceId: true,
        _count: {
          select: { items: true },
        },
      },
    }),
  ]);

  return {
    date: day,
    totalSales: aggregation._sum.amount ?? 0,
    transactionCount: transactions.length,
    sourceBreakdown: bySource.map((entry) => ({
      source: entry.source,
      total: entry._sum.amount ?? 0,
      count: entry._count,
    })),
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      source: t.source,
      status: t.status,
      description: t.description,
      customerName: t.customerName,
      transactionDate: t.transactionDate,
      referenceId: t.referenceId,
      itemsCount: t._count.items,
    })),
  };
}

// ─── Financial Timeline & Overview ───────────────────────────

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
          where: { businessId, ...TAXABLE_SALES_WHERE },
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
        ...TAXABLE_SALES_WHERE,
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
            ...TAXABLE_SALES_WHERE,
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
