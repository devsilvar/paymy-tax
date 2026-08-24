import PDFDocument from 'pdfkit';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { supabaseAdmin } from '@/lib/supabase';
import { Decimal } from '@prisma/client/runtime/library';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { fetchLogoForPdf } from '@/lib/pdf-utils';

// ─── Helpers ────────────────────────────────────────────────

function toNumber(val: Decimal | number | null): number {
  if (val === null) return 0;
  return typeof val === 'number' ? val : val.toNumber();
}

function formatCurrency(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMonth(date: Date): string {
  return date.toLocaleDateString('en-NG', { year: 'numeric', month: 'long' });
}

// ─── PDF Builder ────────────────────────────────────────────

interface ReportRow {
  taxMonth: Date;
  totalSales: Decimal;
  totalExpenses: Decimal;
  grossProfit: Decimal;
  taxRate: Decimal;
  taxPayable: Decimal;
  paymentStatus: string;
  isFinalized: boolean;
}

async function buildPdf(
  business: {
    businessName: string;
    merchantId: string;
    ownerName: string;
    taxId: string | null;
    logoUrl?: string | null;
  },
  reports: ReportRow[],
  periodLabel: string
): Promise<Buffer> {
  const logoBuffer = business.logoUrl
    ? await fetchLogoForPdf(business.logoUrl)
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Logo (if available) ──
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, 45, { fit: [42, 42] });
      } catch {
        // Continue gracefully if image rendering fails
      }
    }

    // ── Header ──
    doc.fontSize(20).font('Helvetica-Bold').text('PayMyTax', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Tax History Statement', { align: 'center' });
    doc.moveDown(0.8);


    // ── Business Info ──
    doc.fontSize(9).font('Helvetica');
    doc.text(`Merchant ID: ${business.merchantId}`);
    doc.text(`Business: ${business.businessName}`);
    doc.text(`Owner: ${business.ownerName}`);
    if (business.taxId) doc.text(`TIN: ${business.taxId}`);
    doc.text(`Period: ${periodLabel}`);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    doc.moveDown(0.5);

    // ── Divider ──
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    if (reports.length === 0) {
      doc.fontSize(11).text('No tax records found for the selected period.', { align: 'center' });
    } else {
      // ── Table Header ──
      const colX = [50, 140, 220, 300, 365, 420, 490];
      const headers = ['Month', 'Sales', 'Expenses', 'Profit', 'Rate', 'Tax Due', 'Status'];

      doc.fontSize(8).font('Helvetica-Bold');
      headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { width: 70, continued: i < headers.length - 1 }));
      doc.text('');
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);

      // ── Table Rows ──
      let grandTotalTax = 0;
      let grandTotalSales = 0;

      doc.font('Helvetica').fontSize(8);
      for (const r of reports) {
        const y = doc.y;
        if (y > 750) {
          doc.addPage();
        }

        const sales = toNumber(r.totalSales);
        const expenses = toNumber(r.totalExpenses);
        const profit = toNumber(r.grossProfit);
        const rate = toNumber(r.taxRate);
        const tax = toNumber(r.taxPayable);
        const status = r.paymentStatus === 'completed' ? 'Paid' : r.isFinalized ? 'Finalized' : 'Pending';

        grandTotalTax += tax;
        grandTotalSales += sales;

        const rowY = doc.y;
        doc.text(formatMonth(r.taxMonth), colX[0], rowY, { width: 85 });
        doc.text(formatCurrency(sales), colX[1], rowY, { width: 75 });
        doc.text(formatCurrency(expenses), colX[2], rowY, { width: 75 });
        doc.text(formatCurrency(profit), colX[3], rowY, { width: 60 });
        doc.text(`${rate}%`, colX[4], rowY, { width: 50 });
        doc.text(formatCurrency(tax), colX[5], rowY, { width: 65 });
        doc.text(status, colX[6], rowY, { width: 55 });
        doc.moveDown(0.6);
      }

      // ── Totals ──
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text(`Total Sales: ${formatCurrency(grandTotalSales)}     |     Total Tax Payable: ${formatCurrency(grandTotalTax)}`, 50);
      doc.text(`Reports: ${reports.length} month(s)`, 50);
    }

    // ── Footer ──
    doc.moveDown(2);
    doc.fontSize(7).font('Helvetica').fillColor('#888888');
    doc.text(`Generated by PayMyTax by WallX  •  Tax Authority: ${config.tax.taxAuthority}  •  Currency: ${config.tax.currency}`, 50, undefined, { align: 'center' });
    doc.text('This is a computer-generated document and does not require a signature.', { align: 'center' });

    doc.end();
  });
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Download tax history as PDF for a single month.
 */
export async function downloadMonthlyStatement(
  userId: string,
  businessId: string,
  month: number,
  year: number
): Promise<{ buffer: Buffer; filename: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const monthStart = new Date(year, month - 1, 1);

  const report = await prisma.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId, taxMonth: monthStart } },
  });

  if (!report) {
    throw new AppError(404, 'No tax report found for this month', 'REPORT_NOT_FOUND');
  }

  const periodLabel = formatMonth(monthStart);
  const buffer = await buildPdf(business, [report], periodLabel);
  const filename = `tax-statement-${business.merchantId}-${year}-${String(month).padStart(2, '0')}.pdf`;

  logAudit({
    userId,
    businessId,
    action: 'statement.downloaded',
    resourceType: 'tax_statement',
    resourceId: report.id,
    newData: { month, year, type: 'monthly' },
  });

  logger.info('Monthly statement downloaded', { businessId, month, year });

  return { buffer, filename };
}

/**
 * Download tax history as PDF for a date range (period).
 */
export async function downloadPeriodStatement(
  userId: string,
  businessId: string,
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number
): Promise<{ buffer: Buffer; filename: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const from = new Date(startYear, startMonth - 1, 1);
  const to = new Date(endYear, endMonth - 1, 1);

  if (from > to) {
    throw new AppError(400, 'Start date must be before end date', 'INVALID_DATE_RANGE');
  }

  const reports = await prisma.monthlyTaxReport.findMany({
    where: {
      businessId,
      taxMonth: { gte: from, lte: to },
    },
    orderBy: { taxMonth: 'asc' },
  });

  if (reports.length === 0) {
    throw new AppError(404, 'No tax reports found for this period', 'NO_REPORTS_FOUND');
  }

  const periodLabel = `${formatMonth(from)} — ${formatMonth(to)}`;
  const buffer = await buildPdf(business, reports, periodLabel);
  const filename = `tax-statement-${business.merchantId}-${startYear}${String(startMonth).padStart(2, '0')}-to-${endYear}${String(endMonth).padStart(2, '0')}.pdf`;

  logAudit({
    userId,
    businessId,
    action: 'statement.downloaded',
    resourceType: 'tax_statement',
    resourceId: businessId,
    newData: { from: from.toISOString(), to: to.toISOString(), type: 'period', reportCount: reports.length },
  });

  logger.info('Period statement downloaded', { businessId, from, to, reportCount: reports.length });

  return { buffer, filename };
}
