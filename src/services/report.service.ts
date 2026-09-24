/**
 * Report Service — generates PDF reports for sales and expenses.
 * Follows the same patterns as statement.service.ts.
 */
import prisma from '@/lib/prisma';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { fetchLogoForPdf } from '@/lib/pdf-utils';
import { logAudit } from '@/lib/audit';
import { toNumber, SETTLED_SALE_STATUSES } from '@/shared/helpers';
import { buildSalesReportPdf, type SalesReportRow } from '@/services/pdf/sales-report.pdf';
import { buildExpenseReportPdf, type ExpenseReportRow } from '@/services/pdf/expense-report.pdf';

// ─── Sales Report ───────────────────────────────────────────

export async function getSalesReportPdf(
  userId: string,
  businessId: string,
  from: string,
  to: string
): Promise<{ buffer: Buffer; filename: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);

  const sales = await prisma.salesTransaction.findMany({
    where: {
      businessId,
      status: { in: SETTLED_SALE_STATUSES },
      transactionDate: { gte: fromDate, lte: toDate },
    },
    include: { classification: true },
    orderBy: { transactionDate: 'asc' },
  });

  // Build rows
  const rows: SalesReportRow[] = sales.map((s) => ({
    date: s.transactionDate || s.createdAt,
    description: s.description,
    source: s.source,
    customerName: s.customerName,
    amount: toNumber(s.amount),
    status: s.status,
  }));

  // Compute breakdown by source
  const breakdown: Record<string, { count: number; total: number }> = {};
  for (const row of rows) {
    if (!breakdown[row.source]) breakdown[row.source] = { count: 0, total: 0 };
    breakdown[row.source].count++;
    breakdown[row.source].total += row.amount;
  }

  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);

  // Fetch logo
  const logoBuffer = business.logoUrl ? await fetchLogoForPdf(business.logoUrl) : null;

  const buffer = await buildSalesReportPdf({
    businessName: business.businessName,
    merchantId: business.merchantId,
    logoBuffer,
    from,
    to,
    rows,
    totalAmount,
    breakdown,
  });

  // Fire-and-forget audit (no tx)
  logAudit({
    userId,
    businessId,
    action: 'sales.report_downloaded',
    newData: { from, to, count: rows.length, totalAmount },
  });

  const filename = `Sales-Report-${from}-to-${to}.pdf`;
  return { buffer, filename };
}

// ─── Expense Report ─────────────────────────────────────────

export async function getExpenseReportPdf(
  userId: string,
  businessId: string,
  from: string,
  to: string
): Promise<{ buffer: Buffer; filename: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);

  const expenses = await prisma.expense.findMany({
    where: {
      businessId,
      expenseDate: { gte: fromDate, lte: toDate },
    },
    orderBy: { expenseDate: 'asc' },
  });

  // Build rows
  const rows: ExpenseReportRow[] = expenses.map((e) => ({
    date: e.expenseDate || e.createdAt,
    description: e.description,
    category: e.category,
    amount: toNumber(e.amount),
  }));

  // Compute breakdown by category
  const breakdown: Record<string, { count: number; total: number }> = {};
  for (const row of rows) {
    if (!breakdown[row.category]) breakdown[row.category] = { count: 0, total: 0 };
    breakdown[row.category].count++;
    breakdown[row.category].total += row.amount;
  }

  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);

  // Fetch logo
  const logoBuffer = business.logoUrl ? await fetchLogoForPdf(business.logoUrl) : null;

  const buffer = await buildExpenseReportPdf({
    businessName: business.businessName,
    merchantId: business.merchantId,
    logoBuffer,
    from,
    to,
    rows,
    totalAmount,
    breakdown,
  });

  // Fire-and-forget audit (no tx)
  logAudit({
    userId,
    businessId,
    action: 'expense.report_downloaded',
    newData: { from, to, count: rows.length, totalAmount },
  });

  const filename = `Expense-Report-${from}-to-${to}.pdf`;
  return { buffer, filename };
}
