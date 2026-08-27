import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';
import { fetchLogoForPdf } from '@/lib/pdf-utils';

// ─── Design Tokens ──────────────────────────────────────────
const COLORS = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  hairline: '#e2e8f0',
  panel: '#f8fafc',
  accent: '#10b981', // Emerald for payments / receipts
  headerBand: '#0f172a',
  onAccent: '#ffffff',
  success: '#16a34a',
  info: '#2563eb',
  warn: '#d97706',
  danger: '#dc2626',
};

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
};

const LEFT = 50;
const RIGHT = 545;
const PAGE_WIDTH = RIGHT - LEFT;
const RADIUS = 6;

function toNumber(v: Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : v.toNumber();
}

function formatMoney(amount: number): string {
  return `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: Date | string): string {
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  return dateObj.toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(d: Date | string): string {
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  return dateObj.toLocaleDateString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Tax Payment Receipt Data Model ─────────────────────────
export interface TaxPaymentReceiptData {
  receiptNumber: string;
  paymentReference: string;
  paymentDate: Date;
  amount: number;
  paymentMethod: string;
  remittanceStatus: 'collected' | 'remitting' | 'remitted';
  firsRemittanceRef?: string | null;
  firsReceiptUrl?: string | null;
  business: {
    businessName: string;
    ownerName: string;
    merchantId: string;
    taxId?: string | null;
    address?: string | null;
    logoUrl?: string | null;
  };
  taxReport: {
    taxMonth: Date;
    totalSales: number;
    totalExpenses: number;
    grossProfit: number;
    taxRate: number;
    taxPayable: number;
  };
}

// ─── DVA Inflow Receipt Data Model ──────────────────────────
export interface DvaTransferReceiptData {
  receiptNumber: string;
  transactionReference: string;
  transactionDate: Date;
  amount: number;
  customerName?: string | null;
  customerHint?: string | null;
  senderBank?: string | null;
  virtualAccountNumber: string;
  virtualAccountBank: string;
  business: {
    businessName: string;
    ownerName: string;
    merchantId: string;
    taxId?: string | null;
    logoUrl?: string | null;
  };
}

/**
 * Builds a professional PDF receipt for Tax Payment (Stage 1 Collection or Stage 2 FIRS Remittance).
 */
export async function buildTaxPaymentReceiptPdf(data: TaxPaymentReceiptData): Promise<Buffer> {
  const logoBuffer = data.business.logoUrl ? await fetchLogoForPdf(data.business.logoUrl) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Tax Receipt ${data.receiptNumber}`, Author: 'PayMyTax by WallX' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const isRemitted = data.remittanceStatus === 'remitted';

    // ── Header Background Band ──
    doc.rect(LEFT, 45, PAGE_WIDTH, 75).fillAndStroke('#0f172a', '#0f172a');

    // ── Logo / Brand ──
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, LEFT + 15, 55, { fit: [55, 55] });
      } catch {
        // Fallback gracefully
      }
    }

    doc.fillColor('#ffffff').fontSize(16).font(FONT.bold)
      .text('PayMyTax', logoBuffer ? LEFT + 80 : LEFT + 20, 60);
    doc.fillColor('#94a3b8').fontSize(9).font(FONT.regular)
      .text('Official FIRS SME Tax Remittance Platform', logoBuffer ? LEFT + 80 : LEFT + 20, 80);

    // ── Document Title Pill (Right) ──
    const titleText = isRemitted ? 'OFFICIAL FIRS TAX RECEIPT' : 'TAX PAYMENT CUSTODY RECEIPT';
    doc.fontSize(10).font(FONT.bold).fillColor('#ffffff')
      .text(titleText, LEFT, 62, { width: PAGE_WIDTH - 20, align: 'right' });

    doc.fontSize(8).font(FONT.regular).fillColor('#cbd5e1')
      .text(`Receipt #: ${data.receiptNumber}`, LEFT, 78, { width: PAGE_WIDTH - 20, align: 'right' });
    doc.fontSize(8).font(FONT.regular).fillColor('#cbd5e1')
      .text(`Issued: ${formatDate(data.paymentDate)}`, LEFT, 92, { width: PAGE_WIDTH - 20, align: 'right' });

    doc.y = 135;

    // ── Stage Status Banner ──
    const bannerBg = isRemitted ? '#f0fdf4' : '#eff6ff';
    const bannerBorder = isRemitted ? '#bbf7d0' : '#bfdbfe';
    const bannerText = isRemitted ? '#166534' : '#1e40af';
    const bannerDesc = isRemitted
      ? `STATUS: REMITTED TO FIRS (Remittance Ref: ${data.firsRemittanceRef || 'VERIFIED'})`
      : 'STATUS: PAYMENT COLLECTED & HELD IN CUSTODY FOR BATCH FIRS REMITTANCE';

    doc.roundedRect(LEFT, doc.y, PAGE_WIDTH, 26, RADIUS).fillAndStroke(bannerBg, bannerBorder);
    doc.fillColor(bannerText).fontSize(8.5).font(FONT.bold)
      .text(bannerDesc, LEFT + 12, doc.y + 8, { width: PAGE_WIDTH - 24, align: 'center' });

    doc.moveDown(1.5);

    // ── Two Column Business & Taxpayer Summary ──
    const topY = doc.y;
    const colWidth = (PAGE_WIDTH - 20) / 2;

    // Left: Business Profile
    doc.roundedRect(LEFT, topY, colWidth, 90, RADIUS).fillAndStroke(COLORS.panel, COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(8).font(FONT.bold).text('TAXPAYER / BUSINESS', LEFT + 12, topY + 10);
    doc.fillColor(COLORS.ink).fontSize(10).font(FONT.bold).text(data.business.businessName, LEFT + 12, topY + 24, { width: colWidth - 24, ellipsis: true });
    doc.fillColor(COLORS.body).fontSize(8.5).font(FONT.regular);
    doc.text(`Owner: ${data.business.ownerName}`, LEFT + 12, topY + 40);
    doc.text(`Merchant ID: ${data.business.merchantId}`, LEFT + 12, topY + 54);
    if (data.business.taxId) {
      doc.text(`Tax ID (TIN): ${data.business.taxId}`, LEFT + 12, topY + 68);
    }

    // Right: Payment Details
    const rightColX = LEFT + colWidth + 20;
    doc.roundedRect(rightColX, topY, colWidth, 90, RADIUS).fillAndStroke(COLORS.panel, COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(8).font(FONT.bold).text('PAYMENT DETAILS', rightColX + 12, topY + 10);
    doc.fillColor(COLORS.ink).fontSize(9).font(FONT.regular);
    doc.text(`Amount Paid: `, rightColX + 12, topY + 24, { continued: true });
    doc.font(FONT.bold).fillColor(COLORS.accent).text(formatMoney(data.amount));
    doc.fillColor(COLORS.body).font(FONT.regular);
    doc.text(`Channel: ${data.paymentMethod.toUpperCase()}`, rightColX + 12, topY + 40);
    doc.text(`Paystack Ref: ${data.paymentReference}`, rightColX + 12, topY + 54, { width: colWidth - 24, ellipsis: true });
    doc.text(`Paid At: ${formatDateTime(data.paymentDate)}`, rightColX + 12, topY + 68);

    doc.y = topY + 105;

    // ── Tax Liability Breakdown Table ──
    doc.fillColor(COLORS.ink).fontSize(11).font(FONT.bold).text('Tax Assessment & Settlement Breakdown', LEFT, doc.y);
    doc.moveDown(0.4);

    const tableY = doc.y;
    doc.rect(LEFT, tableY, PAGE_WIDTH, 22).fillAndStroke('#f1f5f9', COLORS.hairline);
    doc.fillColor(COLORS.ink).fontSize(8.5).font(FONT.bold);
    doc.text('Description / Assessment Item', LEFT + 10, tableY + 6);
    doc.text('Basis / Calculation', LEFT + 240, tableY + 6);
    doc.text('Amount (NGN)', LEFT + 380, tableY + 6, { width: PAGE_WIDTH - 390, align: 'right' });

    doc.y = tableY + 22;

    const taxMonthLabel = new Date(data.taxReport.taxMonth).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
    const rows = [
      { label: `Gross Sales Revenue (${taxMonthLabel})`, basis: 'Direct sales & invoices', amount: data.taxReport.totalSales },
      { label: `Allowable Business Expenses`, basis: 'Tax deductible operating costs', amount: data.taxReport.totalExpenses },
      { label: `Net Assessable Gross Profit`, basis: 'Sales minus Deductible Expenses', amount: data.taxReport.grossProfit },
      { label: `Statutory SME Tax Liability`, basis: `${data.taxReport.taxRate}% of Gross Profit`, amount: data.taxReport.taxPayable },
    ];

    rows.forEach((r, idx) => {
      const rowY = doc.y;
      const isAlt = idx % 2 === 1;
      if (isAlt) {
        doc.rect(LEFT, rowY, PAGE_WIDTH, 20).fill('#fafafa');
      }
      doc.fillColor(COLORS.body).fontSize(8.5).font(idx === 3 ? FONT.bold : FONT.regular);
      doc.text(r.label, LEFT + 10, rowY + 5);
      doc.fillColor(COLORS.muted).font(FONT.regular);
      doc.text(r.basis, LEFT + 240, rowY + 5);
      doc.fillColor(idx === 3 ? COLORS.ink : COLORS.body).font(idx === 3 ? FONT.bold : FONT.regular);
      doc.text(formatMoney(r.amount), LEFT + 380, rowY + 5, { width: PAGE_WIDTH - 390, align: 'right' });
      doc.y = rowY + 20;
    });

    // ── Total Settled Band ──
    const totalBandY = doc.y + 4;
    doc.roundedRect(LEFT, totalBandY, PAGE_WIDTH, 28, RADIUS).fillAndStroke('#0f172a', '#0f172a');
    doc.fillColor('#ffffff').fontSize(10).font(FONT.bold).text('TOTAL TAX OBLIGATION SETTLED', LEFT + 15, totalBandY + 8);
    doc.fontSize(12).font(FONT.bold).text(formatMoney(data.amount), LEFT, totalBandY + 7, { width: PAGE_WIDTH - 15, align: 'right' });

    doc.y = totalBandY + 40;

    // ── FIRS Regulatory Notice & Verification Block ──
    doc.roundedRect(LEFT, doc.y, PAGE_WIDTH, 60, RADIUS).fillAndStroke('#f8fafc', COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(7.5).font(FONT.bold).text('LEGAL & COMPLIANCE NOTICE (FEDERAL INLAND REVENUE SERVICE)', LEFT + 12, doc.y + 8);
    doc.fillColor(COLORS.body).fontSize(7.5).font(FONT.regular);
    doc.text(
      'This document serves as an immutable record of electronic tax settlement processed through PayMyTax by WallX in accordance with the Nigerian SME Company Income Tax Regulations. All transactions are logged with cryptographic audit signatures and reported in designated FIRS monthly clearing batches.',
      LEFT + 12,
      doc.y + 20,
      { width: PAGE_WIDTH - 24, lineGap: 1.5 }
    );

    // ── Footer ──
    const footerY = 760;
    doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).strokeColor(COLORS.hairline).stroke();
    doc.fillColor(COLORS.faint).fontSize(7).font(FONT.regular)
      .text('PayMyTax by WallX • https://paymytax.com • Support: support@paymytax.com • Generated Electronically', LEFT, footerY + 8, { width: PAGE_WIDTH, align: 'center' });

    doc.end();
  });
}

/**
 * Builds a customer-facing PDF receipt for DVA inbound bank transfers.
 */
export async function buildDvaTransferReceiptPdf(data: DvaTransferReceiptData): Promise<Buffer> {
  const logoBuffer = data.business.logoUrl ? await fetchLogoForPdf(data.business.logoUrl) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payment Receipt ${data.receiptNumber}`, Author: data.business.businessName } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header Band ──
    doc.rect(LEFT, 45, PAGE_WIDTH, 70).fillAndStroke('#0f172a', '#0f172a');

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, LEFT + 15, 52, { fit: [50, 50] });
      } catch {
        // Continue
      }
    }

    doc.fillColor('#ffffff').fontSize(15).font(FONT.bold)
      .text(data.business.businessName, logoBuffer ? LEFT + 75 : LEFT + 20, 58);
    doc.fillColor('#94a3b8').fontSize(8.5).font(FONT.regular)
      .text(`Merchant ID: ${data.business.merchantId}`, logoBuffer ? LEFT + 75 : LEFT + 20, 78);

    doc.fontSize(10).font(FONT.bold).fillColor('#ffffff')
      .text('CUSTOMER PAYMENT RECEIPT', LEFT, 60, { width: PAGE_WIDTH - 20, align: 'right' });
    doc.fontSize(8).font(FONT.regular).fillColor('#cbd5e1')
      .text(`Receipt #: ${data.receiptNumber}`, LEFT, 76, { width: PAGE_WIDTH - 20, align: 'right' });
    doc.fontSize(8).font(FONT.regular).fillColor('#cbd5e1')
      .text(`Date: ${formatDate(data.transactionDate)}`, LEFT, 90, { width: PAGE_WIDTH - 20, align: 'right' });

    doc.y = 135;

    // ── Success Callout Banner ──
    doc.roundedRect(LEFT, doc.y, PAGE_WIDTH, 26, RADIUS).fillAndStroke('#f0fdf4', '#bbf7d0');
    doc.fillColor('#166534').fontSize(9).font(FONT.bold)
      .text('TRANSACTION SUCCESSFUL — FUNDS RECEIVED VIA DIRECT BANK TRANSFER', LEFT, doc.y + 8, { width: PAGE_WIDTH, align: 'center' });

    doc.moveDown(1.5);

    // ── Inflow Amount Card ──
    const amountCardY = doc.y;
    doc.roundedRect(LEFT, amountCardY, PAGE_WIDTH, 65, RADIUS).fillAndStroke(COLORS.panel, COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.bold).text('TOTAL AMOUNT RECEIVED', LEFT, amountCardY + 12, { width: PAGE_WIDTH, align: 'center' });
    doc.fillColor(COLORS.accent).fontSize(20).font(FONT.bold).text(formatMoney(data.amount), LEFT, amountCardY + 28, { width: PAGE_WIDTH, align: 'center' });

    doc.y = amountCardY + 80;

    // ── Itemized Transfer Breakdown ──
    doc.fillColor(COLORS.ink).fontSize(11).font(FONT.bold).text('Transfer Details', LEFT, doc.y);
    doc.moveDown(0.4);

    const details = [
      { label: 'Beneficiary Business', value: data.business.businessName },
      { label: 'Payer / Customer', value: data.customerName || data.customerHint || 'Direct Bank Customer' },
      { label: 'Destination Account', value: `${data.virtualAccountBank} — ${data.virtualAccountNumber}` },
      { label: 'Transaction Reference', value: data.transactionReference },
      { label: 'Payment Channel', value: 'Dedicated NUBAN Virtual Account Transfer' },
      { label: 'Timestamp', value: formatDateTime(data.transactionDate) },
      { label: 'Settlement Status', value: 'Confirmed & Credited' },
    ];

    details.forEach((item, idx) => {
      const rowY = doc.y;
      const isAlt = idx % 2 === 1;
      if (isAlt) {
        doc.rect(LEFT, rowY, PAGE_WIDTH, 22).fill('#fafafa');
      }
      doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.regular);
      doc.text(item.label, LEFT + 12, rowY + 6);
      doc.fillColor(COLORS.ink).font(FONT.bold);
      doc.text(item.value, LEFT + 180, rowY + 6, { width: PAGE_WIDTH - 190, ellipsis: true });
      doc.y = rowY + 22;
    });

    doc.moveDown(1.5);

    // ── Notice Block ──
    doc.roundedRect(LEFT, doc.y, PAGE_WIDTH, 45, RADIUS).fillAndStroke('#f8fafc', COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(7.5).font(FONT.bold).text('PAYMENT VERIFICATION & AUDIT', LEFT + 12, doc.y + 8);
    doc.fillColor(COLORS.body).fontSize(7.5).font(FONT.regular);
    doc.text(
      'This receipt confirms credit to the beneficiary dedicated virtual account via the Nigerian Inter-Bank Settlement System (NIBSS). For queries regarding this payment, quote the Transaction Reference above.',
      LEFT + 12,
      doc.y + 18,
      { width: PAGE_WIDTH - 24 }
    );

    // ── Footer ──
    const footerY = 760;
    doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).strokeColor(COLORS.hairline).stroke();
    doc.fillColor(COLORS.faint).fontSize(7).font(FONT.regular)
      .text('Powered by PayMyTax by WallX • https://paymytax.com • Generated Electronically', LEFT, footerY + 8, { width: PAGE_WIDTH, align: 'center' });

    doc.end();
  });
}
