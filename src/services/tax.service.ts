import prisma, { TxClient } from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { Decimal } from '@prisma/client/runtime/library';
import { createMarginWarning } from '@/services/reminder.service';

// ─── Helpers ────────────────────────────────────────────────

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

function toNumber(val: Decimal | number | null): number {
  if (val === null) return 0;
  return typeof val === 'number' ? val : val.toNumber();
}

// ─── Tax Calculation ────────────────────────────────────────

export async function calculateTax(
  userId: string,
  businessId: string,
  month: number,
  year: number,
  taxRateOverride?: number
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const dateFilter = { gte: monthStart, lte: monthEnd };

  // Check if already locked (paid) — can't recalculate a paid month
  const existingReport = await prisma.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId, taxMonth: monthStart } },
    select: { id: true, isLocked: true },
  });

  if (existingReport?.isLocked) {
    throw new AppError(
      423,
      'This month is locked — tax has been paid. Cannot recalculate.',
      'PERIOD_LOCKED'
    );
  }

  // Aggregate confirmed sales and all expenses for the month
  const [salesAgg, expenseAgg] = await Promise.all([
    prisma.salesTransaction.aggregate({
      where: { businessId, transactionDate: dateFilter, status: 'confirmed' },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { businessId, expenseDate: dateFilter },
      _sum: { amount: true },
    }),
  ]);

  const totalSales = toNumber(salesAgg._sum.amount);
  const totalExpenses = toNumber(expenseAgg._sum.amount);
  const grossProfit = Math.max(totalSales - totalExpenses, 0);

  // Tax rate: override > config default (from env). Stored per-report for auditability.
  const taxRate = taxRateOverride ?? config.tax.defaultRate;

  if (taxRate < config.tax.minRate || taxRate > config.tax.maxRate) {
    throw new AppError(
      400,
      `Tax rate must be between ${config.tax.minRate}% and ${config.tax.maxRate}%`,
      'INVALID_TAX_RATE'
    );
  }

  const taxPayable = grossProfit > 0 ? (grossProfit * taxRate) / 100 : 0;
  const profitMargin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;

  // Upsert — create if first calculation for this month, update if recalculating
  const report = await prisma.monthlyTaxReport.upsert({
    where: { businessId_taxMonth: { businessId, taxMonth: monthStart } },
    create: {
      businessId,
      taxMonth: monthStart,
      totalSales,
      totalExpenses,
      grossProfit,
      taxRate,
      taxPayable,
      profitMargin: parseFloat(profitMargin.toFixed(2)),
    },
    update: {
      totalSales,
      totalExpenses,
      grossProfit,
      taxRate,
      taxPayable,
      profitMargin: parseFloat(profitMargin.toFixed(2)),
    },
  });

  logAudit({
    userId,
    businessId,
    action: 'tax.calculated',
    resourceType: 'monthly_tax_report',
    resourceId: report.id,
    newData: { totalSales, totalExpenses, grossProfit, taxRate, taxPayable, profitMargin: parseFloat(profitMargin.toFixed(2)) },
  });

  logger.info('Tax calculated', { reportId: report.id, businessId, month, year, taxPayable });

  // ─── Margin Warnings (non-blocking) ────────────────────────
  const warnings: { type: string; message: string }[] = [];
  const expectedMargin = typeof business.defaultProfitMargin === 'number'
    ? business.defaultProfitMargin
    : 20;
  const monthLabel = monthStart.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });

  if (totalExpenses === 0 && totalSales > 0) {
    const msg = `You recorded ₦${totalSales.toLocaleString('en-NG')} in sales for ${monthLabel} but no expenses. Please log your expenses for accurate tax reporting.`;
    warnings.push({ type: 'no_expenses', message: msg });
    createMarginWarning(businessId, msg, month, year).catch((err) =>
      logger.error('Failed to create margin warning', { err })
    );
  } else if (totalSales > 0 && Math.abs(profitMargin - expectedMargin) > 15) {
    const msg = `Your actual profit margin (${profitMargin.toFixed(1)}%) for ${monthLabel} deviates significantly from your expected margin (${expectedMargin}%). Please review your records.`;
    warnings.push({ type: 'margin_deviation', message: msg });
    createMarginWarning(businessId, msg, month, year).catch((err) =>
      logger.error('Failed to create margin warning', { err })
    );
  }

  return { ...report, warnings };
}

// ─── Reports CRUD ───────────────────────────────────────────

export async function listReports(
  userId: string,
  businessId: string,
  query: { page: number; limit: number; year?: number; status?: string }
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };
  if (query.status) where.paymentStatus = query.status;
  if (query.year) {
    where.taxMonth = {
      gte: new Date(query.year, 0, 1),
      lte: new Date(query.year, 11, 31),
    };
  }

  const offset = (query.page - 1) * query.limit;

  const [reports, total] = await Promise.all([
    prisma.monthlyTaxReport.findMany({
      where,
      skip: offset,
      take: query.limit,
      orderBy: { taxMonth: 'desc' },
    }),
    prisma.monthlyTaxReport.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: reports,
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

export async function getReportById(userId: string, businessId: string, reportId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const report = await prisma.monthlyTaxReport.findUnique({
    where: { id: reportId },
    include: {
      payments: { orderBy: { createdAt: 'desc' } },
      statement: true,
    },
  });

  if (!report || report.businessId !== businessId) {
    throw new AppError(404, 'Tax report not found', 'REPORT_NOT_FOUND');
  }

  return report;
}

// ─── Finalize / Un-finalize ─────────────────────────────────

export async function finalizeReport(userId: string, businessId: string, reportId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const report = await prisma.monthlyTaxReport.findUnique({ where: { id: reportId } });

  if (!report || report.businessId !== businessId) {
    throw new AppError(404, 'Tax report not found', 'REPORT_NOT_FOUND');
  }

  if (report.isFinalized) {
    throw new AppError(400, 'Report is already finalized', 'ALREADY_FINALIZED');
  }

  if (toNumber(report.totalSales) === 0) {
    throw new AppError(400, 'Cannot finalize a report with zero sales', 'ZERO_SALES');
  }

  const updated = await prisma.monthlyTaxReport.update({
    where: { id: reportId },
    data: { isFinalized: true },
  });

  logAudit({
    userId,
    businessId,
    action: 'tax.report_finalized',
    resourceType: 'monthly_tax_report',
    resourceId: reportId,
    newData: { isFinalized: true },
  });

  logger.info('Tax report finalized', { reportId, businessId });

  return updated;
}

export async function unfinalizeReport(userId: string, businessId: string, reportId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const report = await prisma.monthlyTaxReport.findUnique({ where: { id: reportId } });

  if (!report || report.businessId !== businessId) {
    throw new AppError(404, 'Tax report not found', 'REPORT_NOT_FOUND');
  }

  if (!report.isFinalized) {
    throw new AppError(400, 'Report is not finalized', 'NOT_FINALIZED');
  }

  if (report.isLocked) {
    throw new AppError(423, 'Report is locked — tax has been paid. Cannot un-finalize.', 'PERIOD_LOCKED');
  }

  const updated = await prisma.monthlyTaxReport.update({
    where: { id: reportId },
    data: { isFinalized: false },
  });

  logAudit({
    userId,
    businessId,
    action: 'tax.report_unfinalized',
    resourceType: 'monthly_tax_report',
    resourceId: reportId,
    newData: { isFinalized: false },
  });

  logger.info('Tax report un-finalized', { reportId, businessId });

  return updated;
}

// ─── Dashboard ──────────────────────────────────────────────

export async function getDashboard(
  userId: string,
  businessId: string,
  trendMonths: number
) {
  await verifyBusinessOwnership(userId, businessId);

  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Current month report (may not exist yet)
  const currentReport = await prisma.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId, taxMonth: currentMonthStart } },
  });

  // Trends: last N months of reports
  const trendStart = new Date(now.getFullYear(), now.getMonth() - trendMonths + 1, 1);

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

  // Aggregate totals across all time for this business
  const lifetime = await prisma.monthlyTaxReport.aggregate({
    where: { businessId },
    _sum: { totalSales: true, totalExpenses: true, taxPayable: true },
    _count: true,
  });

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
    currentMonth: currentReport,
    trends,
    lifetime: {
      totalSales: toNumber(lifetime._sum.totalSales),
      totalExpenses: toNumber(lifetime._sum.totalExpenses),
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

interface AnalyticsQuery {
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
