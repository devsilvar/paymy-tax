import prisma from '@/lib/prisma';
import { config } from '@/config';
import { AppError } from '@/middleware/errorHandler';
import { Decimal } from '@prisma/client/runtime/library';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { toNumber, TAXABLE_SALES_WHERE } from '@/shared/helpers';

// ─── Dashboard ──────────────────────────────────────────────

export async function getDashboard(
  userId: string,
  businessId: string,
  trendMonths: number
) {
  await verifyBusinessOwnership(userId, businessId);

  const now = new Date();
  // UTC bounds — must match the UTC-built taxMonth in calculateTax so the
  // unique-key lookup hits. Local-time midnight on UTC+ would miss January
  // reports (stored as previous-Dec-31 in UTC) and dashboard would show "no
  // report for current month" the second the user crosses a month boundary.
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const currentDateFilter = { gte: currentMonthStart, lte: currentMonthEnd };

  // Current month report (may not exist yet)
  const currentReport = await prisma.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId, taxMonth: currentMonthStart } },
  });

  // Live money figures. The dashboard reads REAL-TIME SalesTransaction/Expense
  // rows (identical filters to calculateTax) instead of the stored
  // MonthlyTaxReport snapshot — report rows only change on "Calculate Tax",
  // so reading them here froze the dashboard until a recalculation. With live
  // aggregates, adding a sale/expense (or marking an invoice paid, which
  // creates a sale) reflects on the dashboard immediately.
  const [liveSalesAgg, liveExpenseAgg, monthSalesAgg, monthExpenseAgg] =
    await Promise.all([
      prisma.salesTransaction.aggregate({
        // Same settled-status rule as calculateTax — the dashboard must match
        // what "Calculate Tax" would produce.
        where: { businessId, ...TAXABLE_SALES_WHERE },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { businessId, isDeductible: true },
        _sum: { amount: true },
      }),
      prisma.salesTransaction.aggregate({
        // Same settled-status rule as calculateTax — this feeds the "This
        // Month" card (sales + live-recomputed taxPayable).
        where: {
          businessId,
          transactionDate: currentDateFilter,
          ...TAXABLE_SALES_WHERE,
        },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { businessId, expenseDate: currentDateFilter, isDeductible: true },
        _sum: { amount: true },
      }),
    ]);

  const lifetimeSales = toNumber(liveSalesAgg._sum.amount);
  const lifetimeExpenses = toNumber(liveExpenseAgg._sum.amount);
  const monthSales = toNumber(monthSalesAgg._sum.amount);
  const monthExpenses = toNumber(monthExpenseAgg._sum.amount);

  // Trends: last N months of reports
  const trendStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - trendMonths + 1, 1)
  );

  const trends = await prisma.monthlyTaxReport.findMany({
    where: {
      businessId,
      taxMonth: { gte: trendStart, lte: currentMonthStart },
    },
    orderBy: { taxMonth: 'asc' },
    select: {
      taxMonth: true,
      totalSales: true,
      totalExpenses: true,
      grossProfit: true,
      taxPayable: true,
      taxRate: true,
      profitMargin: true,
      paymentStatus: true,
      isFinalized: true,
      isLocked: true,
    },
  });

  // Lifetime tax payable + report count still come from reports — tax payable
  // only exists once a report is calculated, and reportsCount is a report metric.
  const lifetime = await prisma.monthlyTaxReport.aggregate({
    where: { businessId },
    _sum: { taxPayable: true },
    _count: true,
  });

  // Current month card — live numbers, report fields where they matter:
  //  - Locked (paid) months: the stored report is the audit record and live
  //    rows can't change a locked month, so show it untouched.
  //  - Report exists (draft/finalized, unpaid): live totals + the report's
  //    rate/status, with taxPayable recomputed so the card stays consistent
  //    with what "Calculate Tax" would produce right now.
  //  - No report yet: build a live "draft preview" so the card lights up as
  //    soon as data exists instead of demanding a calculation first.
  let currentMonth = currentReport;
  if (currentReport && !currentReport.isLocked) {
    const grossProfit = Math.max(monthSales - monthExpenses, 0);
    const rate = toNumber(currentReport.taxRate);
    currentMonth = {
      ...currentReport,
      totalSales: new Decimal(monthSales),
      totalExpenses: new Decimal(monthExpenses),
      grossProfit: new Decimal(grossProfit),
      taxPayable: new Decimal(grossProfit > 0 ? (grossProfit * rate) / 100 : 0),
      profitMargin:
        monthSales > 0
          ? new Decimal(parseFloat(((grossProfit / monthSales) * 100).toFixed(2)))
          : new Decimal(0),
    };
  } else if (!currentReport && (monthSales > 0 || monthExpenses > 0)) {
    const grossProfit = Math.max(monthSales - monthExpenses, 0);
    const rate = config.tax.defaultRate;
    currentMonth = {
      id: 'live-preview',
      businessId,
      taxMonth: currentMonthStart,
      totalSales: new Decimal(monthSales),
      totalExpenses: new Decimal(monthExpenses),
      grossProfit: new Decimal(grossProfit),
      taxRate: new Decimal(rate),
      taxPayable: new Decimal(grossProfit > 0 ? (grossProfit * rate) / 100 : 0),
      profitMargin:
        monthSales > 0
          ? new Decimal(parseFloat(((grossProfit / monthSales) * 100).toFixed(2)))
          : new Decimal(0),
      paymentStatus: 'pending',
      isFinalized: false,
      isLocked: false,
      lockedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Unpaid finalized reports — these need attention
  const unpaidCount = await prisma.monthlyTaxReport.count({
    where: {
      businessId,
      isFinalized: true,
      paymentStatus: 'pending',
    },
  });

  // Current tax config — so the frontend knows what rate is in effect
  const taxConfig = {
    currentRate: config.tax.defaultRate,
    currency: config.tax.currency,
    authority: config.tax.taxAuthority,
  };

  return {
    currentMonth,
    trends,
    lifetime: {
      // Live totals — reflect every confirmed/taxable sale and deductible
      // expense immediately, not just what the last tax calculation saw.
      totalSales: lifetimeSales,
      totalExpenses: lifetimeExpenses,
      totalTaxPayable: toNumber(lifetime._sum.taxPayable),
      reportsCount: lifetime._count,
    },
    unpaidCount,
    taxConfig,
  };
}

// ─── Analytics ──────────────────────────────────────────────
//
// Visual history view: pre-aggregated KPIs + monthly series + YoY + status
// distribution in a single call. Window is capped server-side at 60 months.

const ANALYTICS_MAX_MONTHS = 60;

function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function parseMonthKey(key: string): Date {
  // "YYYY-MM" → first day of that month, UTC (validator guarantees the format)
  const parts = key.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return new Date(Date.UTC(y, m - 1, 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function monthsBetween(from: Date, to: Date): number {
  // inclusive count, assumes from <= to and both are first-of-month UTC
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) + 1;
}

function pctDelta(curr: number, prior: number): number | null {
  if (prior === 0) return null; // avoid div-by-zero; caller interprets null as "no basis"
  return parseFloat((((curr - prior) / prior) * 100).toFixed(2));
}

export interface AnalyticsQuery {
  from?: string;
  to?: string;
  range?: '6m' | '12m' | '24m' | 'all' | 'custom';
}

export async function getTaxAnalytics(
  userId: string,
  businessId: string,
  query: AnalyticsQuery
) {
  await verifyBusinessOwnership(userId, businessId);

  const now = new Date();
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // ─── Resolve window ────────────────────────────────────────
  let from: Date;
  let to: Date;

  if (query.range && query.range !== 'custom') {
    to = currentMonth;
    if (query.range === 'all') {
      // Look back at the earliest report for this business; cap at 60 months.
      const earliest = await prisma.monthlyTaxReport.findFirst({
        where: { businessId },
        orderBy: { taxMonth: 'asc' },
        select: { taxMonth: true },
      });
      if (earliest) {
        const earliestUtc = new Date(Date.UTC(
          earliest.taxMonth.getUTCFullYear(),
          earliest.taxMonth.getUTCMonth(),
          1
        ));
        const hardFloor = addMonths(currentMonth, -(ANALYTICS_MAX_MONTHS - 1));
        from = earliestUtc < hardFloor ? hardFloor : earliestUtc;
      } else {
        // No reports yet — default to last 12 months so the empty state still looks sensible.
        from = addMonths(currentMonth, -11);
      }
    } else {
      const n = query.range === '6m' ? 6 : query.range === '12m' ? 12 : 24;
      from = addMonths(currentMonth, -(n - 1));
    }
  } else if (query.range === 'custom' || query.from || query.to) {
    // Custom range — require both bounds for deterministic behavior.
    if (!query.from || !query.to) {
      throw new AppError(
        400,
        'Custom range requires both "from" and "to" (YYYY-MM)',
        'RANGE_INCOMPLETE'
      );
    }
    from = parseMonthKey(query.from);
    to = parseMonthKey(query.to);
    if (from > to) {
      throw new AppError(400, '"from" must be before or equal to "to"', 'RANGE_INVERTED');
    }
    if (monthsBetween(from, to) > ANALYTICS_MAX_MONTHS) {
      throw new AppError(
        400,
        `Range cannot exceed ${ANALYTICS_MAX_MONTHS} months`,
        'RANGE_TOO_WIDE'
      );
    }
  } else {
    // Default: last 12 months ending at current month.
    to = currentMonth;
    from = addMonths(currentMonth, -11);
  }

  const monthsInRange = monthsBetween(from, to);

  // ─── Fetch reports for window ──────────────────────────────
  // Note: we fetch using the full-month-end bound so a report dated the 1st is included.
  const windowEnd = addMonths(to, 1); // exclusive
  const reports = await prisma.monthlyTaxReport.findMany({
    where: { businessId, taxMonth: { gte: from, lt: windowEnd } },
    orderBy: { taxMonth: 'asc' },
    select: {
      id: true,
      taxMonth: true,
      totalSales: true,
      totalExpenses: true,
      grossProfit: true,
      taxPayable: true,
      profitMargin: true,
      paymentStatus: true,
      isFinalized: true,
      isLocked: true,
    },
  });

  // Index by YYYY-MM for gap-filled iteration.
  const byMonth = new Map<string, (typeof reports)[number]>();
  for (const r of reports) byMonth.set(monthKey(r.taxMonth), r);

  // ─── Build gap-filled series ───────────────────────────────
  const series: Array<{
    taxMonth: string;
    totalSales: number;
    totalExpenses: number;
    grossProfit: number;
    taxPayable: number;
    profitMargin: number;
    paymentStatus: 'none' | 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
    isFinalized: boolean;
    isLocked: boolean;
    reportId: string | null;
  }> = [];

  for (let i = 0; i < monthsInRange; i++) {
    const d = addMonths(from, i);
    const key = monthKey(d);
    const r = byMonth.get(key);
    if (r) {
      series.push({
        taxMonth: key,
        totalSales: toNumber(r.totalSales),
        totalExpenses: toNumber(r.totalExpenses),
        grossProfit: toNumber(r.grossProfit),
        taxPayable: toNumber(r.taxPayable),
        profitMargin: toNumber(r.profitMargin),
        paymentStatus: r.paymentStatus,
        isFinalized: r.isFinalized,
        isLocked: r.isLocked,
        reportId: r.id,
      });
    } else {
      series.push({
        taxMonth: key,
        totalSales: 0,
        totalExpenses: 0,
        grossProfit: 0,
        taxPayable: 0,
        profitMargin: 0,
        paymentStatus: 'none',
        isFinalized: false,
        isLocked: false,
        reportId: null,
      });
    }
  }

  // ─── KPIs (current window) ─────────────────────────────────
  let totalTaxPaid = 0;
  let totalTaxOwed = 0;
  let monthsWithPaidReport = 0;

  for (const r of reports) {
    const tax = toNumber(r.taxPayable);
    if (r.isLocked) {
      totalTaxPaid += tax;
      monthsWithPaidReport += 1;
    } else if (r.isFinalized) {
      totalTaxOwed += tax;
    }
  }

  const reportsFiled = reports.length;
  const averageMonthlyTax = monthsWithPaidReport > 0
    ? parseFloat((totalTaxPaid / monthsWithPaidReport).toFixed(2))
    : 0;

  // ─── Prior window for deltas ───────────────────────────────
  const priorTo = addMonths(from, -1);
  const priorFrom = addMonths(priorTo, -(monthsInRange - 1));
  const priorEnd = addMonths(priorTo, 1);

  const priorReports = await prisma.monthlyTaxReport.findMany({
    where: { businessId, taxMonth: { gte: priorFrom, lt: priorEnd } },
    select: { taxPayable: true, isLocked: true, isFinalized: true },
  });

  let priorPaid = 0;
  let priorOwed = 0;
  for (const r of priorReports) {
    const tax = toNumber(r.taxPayable);
    if (r.isLocked) priorPaid += tax;
    else if (r.isFinalized) priorOwed += tax;
  }

  const deltas = priorReports.length === 0
    ? { totalTaxPaidPct: null, totalTaxOwedPct: null, reportsFiledPct: null }
    : {
        totalTaxPaidPct: pctDelta(totalTaxPaid, priorPaid),
        totalTaxOwedPct: pctDelta(totalTaxOwed, priorOwed),
        reportsFiledPct: pctDelta(reportsFiled, priorReports.length),
      };

  // ─── Status distribution (real reports only) ───────────────
  const statusDistribution = { paid: 0, pending: 0, failed: 0 };
  for (const r of reports) {
    if (r.paymentStatus === 'failed') statusDistribution.failed += 1;
    else if (r.isLocked) statusDistribution.paid += 1;
    else statusDistribution.pending += 1;
  }

  // ─── YoY: only when window spans ≥ 2 calendar years AND both have data ───
  const yearsInWindow = new Set<number>();
  for (const r of reports) yearsInWindow.add(r.taxMonth.getUTCFullYear());

  let yoy: {
    currentYear: number;
    priorYear: number;
    months: Array<{ month: number; current: number | null; prior: number | null; deltaPct: number | null }>;
  } | null = null;

  if (yearsInWindow.size >= 2) {
    // Pick the latest two years present in the window. Either could be incomplete,
    // that's why each month entry is nullable.
    const sortedYears = [...yearsInWindow].sort((a, b) => b - a);
    const currentYear = sortedYears[0]!;
    const priorYear = sortedYears[1]!;

    const byYearMonth = new Map<string, number>();
    for (const r of reports) {
      const y = r.taxMonth.getUTCFullYear();
      const m = r.taxMonth.getUTCMonth() + 1;
      if (y === currentYear || y === priorYear) {
        byYearMonth.set(`${y}-${m}`, toNumber(r.taxPayable));
      }
    }

    const months = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const current = byYearMonth.has(`${currentYear}-${m}`)
        ? byYearMonth.get(`${currentYear}-${m}`)!
        : null;
      const prior = byYearMonth.has(`${priorYear}-${m}`)
        ? byYearMonth.get(`${priorYear}-${m}`)!
        : null;
      const deltaPct =
        current !== null && prior !== null ? pctDelta(current, prior) : null;
      return { month: m, current, prior, deltaPct };
    });

    yoy = { currentYear, priorYear, months };
  }

  return {
    window: {
      from: monthKey(from),
      to: monthKey(to),
      monthsInRange,
    },
    kpis: {
      totalTaxPaid: parseFloat(totalTaxPaid.toFixed(2)),
      totalTaxOwed: parseFloat(totalTaxOwed.toFixed(2)),
      reportsFiled,
      averageMonthlyTax,
      deltas,
    },
    series,
    statusDistribution,
    yoy,
  };
}
