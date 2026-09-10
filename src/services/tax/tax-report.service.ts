import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { createMarginWarning } from '@/services/reminder.service';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { buildTaxSlipPdf } from '@/services/tax-slip.pdf';
import { toNumber, TAXABLE_SALES_WHERE } from '@/shared/helpers';

// ─── Tax Calculation ────────────────────────────────────────

export async function calculateTax(
  userId: string,
  businessId: string,
  month: number,
  year: number,
  taxRateOverride?: number
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // Build month bounds in UTC. `taxMonth`, `transactionDate`, and `expenseDate`
  // are all @db.Date — Prisma serialises JS Date as UTC, so a local-time
  // midnight on a UTC+ host (Lagos = UTC+1) truncates to the previous day in
  // Postgres. `Date.UTC(...)` pins the calendar date to what the user asked for.
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0));
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

  // Aggregate settled, taxable sales and deductible expenses for the month.
  // 'confirmed' is the canonical settled status (import/DVA/invoice-verified
  // rows); 'completed' is the legacy manual-entry status. Counting only one of
  // them silently dropped the other half of the business's sales from tax.
  const [salesAgg, expenseAgg] = await Promise.all([
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: dateFilter,
        ...TAXABLE_SALES_WHERE,
      },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { businessId, expenseDate: dateFilter, isDeductible: true },
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
  // `defaultProfitMargin` is a Prisma Decimal — `typeof` is 'object', never
  // 'number'. Using toNumber() preserves the configured value; falling through
  // to 20 (the legacy default) only when truly null/undefined.
  const warnings: { type: string; message: string }[] = [];
  const expectedMargin =
    business.defaultProfitMargin != null
      ? toNumber(business.defaultProfitMargin)
      : 20;
  const monthLabel = monthStart.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });

  if (totalExpenses === 0 && totalSales > 0) {
    const msg = `You recorded ₦${totalSales.toLocaleString('en-NG')} in sales for ${monthLabel} but no expenses. Please log your expenses for accurate tax reporting.`;
    warnings.push({ type: 'no_expenses', message: msg });
    try {
      await createMarginWarning(businessId, msg, month, year);
    } catch (err) {
      logger.error('Failed to create margin warning', { err });
    }
  } else if (totalSales > 0 && Math.abs(profitMargin - expectedMargin) > 15) {
    const msg = `Your actual profit margin (${profitMargin.toFixed(1)}%) for ${monthLabel} deviates significantly from your expected margin (${expectedMargin}%). Please review your records.`;
    warnings.push({ type: 'margin_deviation', message: msg });
    try {
      await createMarginWarning(businessId, msg, month, year);
    } catch (err) {
      logger.error('Failed to create margin warning', { err });
    }
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
    // UTC bounds — same reason as in calculateTax: taxMonth is @db.Date.
    where.taxMonth = {
      gte: new Date(Date.UTC(query.year, 0, 1)),
      lte: new Date(Date.UTC(query.year, 11, 31)),
    };
  }

  const offset = (query.page - 1) * query.limit;

  const [reports, total] = await Promise.all([
    prisma.monthlyTaxReport.findMany({
      where,
      skip: offset,
      take: query.limit,
      orderBy: { taxMonth: 'desc' },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            transactionReference: true,
            amountPaid: true,
            paymentMethod: true,
            paymentStatus: true,
            paymentDate: true,
            firsRemittanceRef: true,
            firsReceiptUrl: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.monthlyTaxReport.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  const formattedReports = reports.map((r) => {
    const latestPayment = r.payments && r.payments.length > 0 ? r.payments[0] : null;
    return {
      ...r,
      latestPayment,
    };
  });

  return {
    data: formattedReports,
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

export async function resetReport(userId: string, businessId: string, reportId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const report = await prisma.monthlyTaxReport.findUnique({
    where: { id: reportId },
    include: { payments: true },
  });

  if (!report || report.businessId !== businessId) {
    throw new AppError(404, 'Tax report not found', 'REPORT_NOT_FOUND');
  }

  // Hard financial immutability guards (enforced across all environments):
  if (report.isLocked) {
    throw new AppError(
      423,
      'Cannot reset a locked tax report. Payment has already been remitted.',
      'PERIOD_LOCKED'
    );
  }

  const hasCompletedPayment = report.payments?.some((p) => p.paymentStatus === 'completed');
  if (hasCompletedPayment) {
    throw new AppError(
      400,
      'Cannot reset report with completed tax payments.',
      'PAYMENT_COMPLETED'
    );
  }

  if (report.isFinalized) {
    throw new AppError(
      400,
      'Finalized reports cannot be reset. Use unfinalize instead.',
      'REPORT_FINALIZED'
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Only delete pending, failed, or abandoned payment attempts
    await tx.taxPayment.deleteMany({
      where: {
        taxReportId: reportId,
        paymentStatus: { in: ['pending', 'failed'] },
      },
    });

    // Delete any statements linked to this report
    await tx.taxStatement.deleteMany({
      where: { taxReportId: reportId },
    });

    // Reset report back to draft
    const res = await tx.monthlyTaxReport.update({
      where: { id: reportId },
      data: {
        paymentStatus: 'pending',
        isFinalized: false,
        isLocked: false,
        lockedAt: null,
      },
    });

    // Clean up any reminders referencing this report
    await tx.reminder.deleteMany({
      where: {
        businessId,
        referenceType: 'monthly_tax_report',
        referenceId: reportId,
      },
    });

    return res;
  });

  logAudit({
    userId,
    businessId,
    action: 'tax.report_reset',
    resourceType: 'monthly_tax_report',
    resourceId: reportId,
    newData: { isFinalized: false, isLocked: false, paymentStatus: 'pending' },
  });

  logger.info('Tax report reset to draft', { reportId, businessId });

  return updated;
}

/**
 * Generates an official Monthly Tax Assessment Slip PDF for a specific tax report.
 */
export async function downloadTaxSlip(
  userId: string,
  businessId: string,
  reportId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const report = await prisma.monthlyTaxReport.findUnique({
    where: { id: reportId },
    include: {
      payments: {
        where: { paymentStatus: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!report || report.businessId !== businessId) {
    throw new AppError(404, 'Tax report not found', 'REPORT_NOT_FOUND');
  }

  const taxDate = new Date(report.taxMonth);
  const year = taxDate.getUTCFullYear();
  const month = String(taxDate.getUTCMonth() + 1).padStart(2, '0');
  const merchantSuffix = (business.merchantId || business.id).slice(0, 6).toUpperCase();
  const slipNumber = `SLIP-${year}${month}-${merchantSuffix}`;

  const isPaid = report.paymentStatus === 'completed' || report.isLocked;
  const latestPayment = report.payments && report.payments.length > 0 ? report.payments[0] : null;

  let paymentData = null;
  if (latestPayment) {
    paymentData = {
      paymentReference: latestPayment.transactionReference,
      paymentDate: latestPayment.paymentDate,
      paymentMethod: latestPayment.paymentMethod,
      amountPaid: toNumber(latestPayment.amountPaid),
      paymentStatus: latestPayment.paymentStatus,
    };
  } else if (isPaid) {
    paymentData = {
      paymentReference: `PMT-${merchantSuffix}-${year}${month}-STATUTORY`,
      paymentDate: report.lockedAt || report.updatedAt || new Date(),
      paymentMethod: 'Electronic Remittance',
      amountPaid: toNumber(report.taxPayable),
      paymentStatus: 'completed',
    };
  }

  const pdfBuffer = await buildTaxSlipPdf({
    slipNumber,
    taxMonth: taxDate,
    generatedAt: new Date(),
    isFinalized: report.isFinalized,
    isLocked: report.isLocked,
    paymentStatus: report.paymentStatus,
    business: {
      businessName: business.businessName,
      merchantId: business.merchantId,
      ownerName: business.ownerName,
      taxId: business.taxId,
      address: business.address || [business.city, business.state].filter(Boolean).join(', ') || null,
      logoUrl: business.logoUrl,
    },
    assessment: {
      totalSales: toNumber(report.totalSales),
      totalExpenses: toNumber(report.totalExpenses),
      grossProfit: toNumber(report.grossProfit),
      taxRate: toNumber(report.taxRate),
      taxPayable: toNumber(report.taxPayable),
      profitMargin: report.profitMargin ? toNumber(report.profitMargin) : null,
    },
    payment: paymentData,
  });

  const filename = `tax-slip-${business.merchantId || 'sme'}-${year}-${month}.pdf`;

  logAudit({
    userId,
    businessId,
    action: 'tax_slip.downloaded',
    resourceType: 'monthly_tax_report',
    resourceId: report.id,
    newData: { reportId: report.id, year, month, slipNumber },
  });

  logger.info('Monthly tax slip downloaded', { businessId, reportId, slipNumber });

  return { buffer: pdfBuffer, filename };
}
