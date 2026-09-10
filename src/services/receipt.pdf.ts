import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';
import { fetchLogoForPdf } from '@/lib/pdf-utils';
import { toNumber } from '@/shared/helpers';

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

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? qty.toString() : qty.toLocaleString('en-NG', { maximumFractionDigits: 2 });
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
    address?: string | null;
    logoUrl?: string | null;
  };
}

// ─── Universal Itemized Sales Receipt Data Model ────────────
export interface SalesReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface SalesReceiptData {
  receiptNumber: string;
  transactionReference?: string | null;
  transactionDate: Date;
  amount: number;
  source: 'bank_transfer' | 'paycode' | 'pos' | 'online_store' | 'manual' | 'cash' | 'invoice';
  sourceLabel: string; // "Bank Transfer", "Cash Sale", "Invoice Payment", etc.
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerAddress?: string | null;
  description?: string | null;
  invoiceNumber?: string | null; // For invoice payments
  items: SalesReceiptItem[];
  subtotal: number;
  discount?: number;
  vatRate?: number;
  vatAmount?: number;
  business: {
    businessName: string;
    ownerName: string;
    merchantId: string;
    taxId?: string | null;
    address?: string | null;
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
 * Builds a customer-facing PDF receipt for DVA inbound bank transfers (Credit Advice).
 */
export async function buildDvaTransferReceiptPdf(data: DvaTransferReceiptData): Promise<Buffer> {
  const logoBuffer = data.business.logoUrl ? await fetchLogoForPdf(data.business.logoUrl) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `Credit Advice ${data.receiptNumber}`, Author: data.business.businessName },
    });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Top Emerald Accent Bar ──
    doc.rect(0, 0, doc.page.width, 6).fillColor(COLORS.accent).fill();

    // ── Header Section ──
    const HEADER_TOP = 45;
    const LEFT_COL_WIDTH = 290;
    const RIGHT_COL_WIDTH = 185;
    const RIGHT_COL_X = RIGHT - RIGHT_COL_WIDTH;

    // Logo (if available)
    const LOGO_SIZE = 44;
    let textStartX = LEFT;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, LEFT, HEADER_TOP, { fit: [LOGO_SIZE, LOGO_SIZE] });
        textStartX = LEFT + LOGO_SIZE + 10;
      } catch {
        textStartX = LEFT;
      }
    }

    const leftColWidthAdjusted = LEFT_COL_WIDTH - (textStartX - LEFT);

    // Left Column: Business Details
    let leftY = HEADER_TOP;
    doc.fillColor(COLORS.ink).fontSize(14).font(FONT.bold);
    doc.text(data.business.businessName, textStartX, leftY, { width: leftColWidthAdjusted });
    leftY += doc.heightOfString(data.business.businessName, { width: leftColWidthAdjusted }) + 3;

    doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.regular);
    doc.text(`Merchant ID: ${data.business.merchantId}`, textStartX, leftY, { width: leftColWidthAdjusted });
    leftY += 12;

    if (data.business.taxId) {
      doc.text(`Tax ID (TIN): ${data.business.taxId}`, textStartX, leftY, { width: leftColWidthAdjusted });
      leftY += 12;
    }
    if (data.business.address) {
      doc.text(data.business.address, textStartX, leftY, { width: leftColWidthAdjusted });
      leftY += doc.heightOfString(data.business.address, { width: leftColWidthAdjusted }) + 3;
    }

    // Right Column: Title, Receipt #, Date, Status
    let rightY = HEADER_TOP;
    doc.fillColor(COLORS.ink).fontSize(13).font(FONT.bold)
      .text('BANK TRANSFER RECEIPT', RIGHT_COL_X, rightY, { width: RIGHT_COL_WIDTH, align: 'right' });
    rightY += 18;

    doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.regular)
      .text(`Receipt #: ${data.receiptNumber}`, RIGHT_COL_X, rightY, { width: RIGHT_COL_WIDTH, align: 'right' });
    rightY += 12;

    doc.text(`Date: ${formatDateTime(data.transactionDate)}`, RIGHT_COL_X, rightY, { width: RIGHT_COL_WIDTH, align: 'right' });
    rightY += 16;

    // Status Pill on Right
    const pillText = 'SUCCESSFUL';
    doc.fontSize(8).font(FONT.bold);
    const pillW = doc.widthOfString(pillText) + 16;
    const pillX = RIGHT - pillW;
    doc.roundedRect(pillX, rightY, pillW, 16, 8).fillColor('#16a34a').fill();
    doc.fillColor('#ffffff').text(pillText, pillX, rightY + 4, { width: pillW, align: 'center' });
    rightY += 22;

    // ── Divider ──
    const dividerY = Math.max(leftY, rightY) + 12;
    doc.strokeColor(COLORS.hairline).lineWidth(1).moveTo(LEFT, dividerY).lineTo(RIGHT, dividerY).stroke();

    // ── Amount Hero Card ──
    const amountCardY = dividerY + 14;
    doc.roundedRect(LEFT, amountCardY, PAGE_WIDTH, 68, RADIUS).fillAndStroke('#f0fdf4', '#bbf7d0');
    doc.fillColor('#166534').fontSize(8.5).font(FONT.bold)
      .text('TOTAL AMOUNT CREDITED', LEFT, amountCardY + 12, { width: PAGE_WIDTH, align: 'center' });
    doc.fillColor(COLORS.ink).fontSize(22).font(FONT.bold)
      .text(formatMoney(data.amount), LEFT, amountCardY + 26, { width: PAGE_WIDTH, align: 'center' });
    doc.fillColor('#15803d').fontSize(8).font(FONT.regular)
      .text('Settled via Nigerian Inter-Bank Settlement System (NIBSS) • Instant Wallet Credit', LEFT, amountCardY + 52, { width: PAGE_WIDTH, align: 'center' });

    // ── Transfer Details Section ──
    const detailsStartY = amountCardY + 84;
    doc.fillColor(COLORS.ink).fontSize(11).font(FONT.bold).text('Transfer & Settlement Details', LEFT, detailsStartY);

    let tableY = detailsStartY + 18;
    const labelColW = 160;
    const valColX = LEFT + labelColW + 10;
    const valColW = PAGE_WIDTH - labelColW - 20;

    const details: Array<{ label: string; value: string }> = [
      { label: 'Beneficiary Business', value: data.business.businessName },
      { label: 'Destination Account', value: `${data.virtualAccountBank} — ${data.virtualAccountNumber}` },
      { label: 'Payer / Counterparty', value: data.customerName || data.customerHint || 'Direct Bank Customer' },
      { label: 'Transaction Reference', value: data.transactionReference },
      { label: 'Payment Channel', value: 'Dedicated NUBAN Virtual Account Transfer (NIP)' },
      { label: 'Value Date & Time', value: formatDateTime(data.transactionDate) },
      { label: 'Settlement Status', value: 'Confirmed & Credited to Business Wallet' },
      { label: 'FIRS Regulatory Record', value: 'Captured for SME Tax Assessment' },
    ];

    details.forEach((item, idx) => {
      doc.fontSize(8.5).font(FONT.regular);
      const valHeight = doc.heightOfString(item.value, { width: valColW });
      const rowHeight = Math.max(22, valHeight + 8);

      if (idx % 2 === 1) {
        doc.rect(LEFT, tableY, PAGE_WIDTH, rowHeight).fill('#f8fafc');
      }

      doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.regular);
      doc.text(item.label, LEFT + 12, tableY + 5);

      doc.fillColor(COLORS.ink).font(FONT.bold);
      doc.text(item.value, valColX, tableY + 5, { width: valColW });

      tableY += rowHeight;
    });

    // ── Notice Block ──
    const noticeY = tableY + 16;
    doc.roundedRect(LEFT, noticeY, PAGE_WIDTH, 48, RADIUS).fillAndStroke('#f8fafc', COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(7.5).font(FONT.bold)
      .text('LEGAL & COMPLIANCE CONFIRMATION', LEFT + 14, noticeY + 8);
    doc.fillColor(COLORS.body).fontSize(7.5).font(FONT.regular);
    doc.text(
      'This electronic credit advice certifies that funds were received through the Nigerian Inter-Bank Settlement System (NIBSS) into the merchant\'s dedicated virtual account. All records are cryptographically logged for SME accounting and FIRS compliance.',
      LEFT + 14,
      noticeY + 20,
      { width: PAGE_WIDTH - 28, lineGap: 1.5 }
    );

    // ── Footer ──
    const footerY = 760;
    doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).strokeColor(COLORS.hairline).stroke();
    doc.fillColor(COLORS.faint).fontSize(7).font(FONT.regular)
      .text('Powered by PayMyTax by WallX • https://paymytax.com • Generated Electronically', LEFT, footerY + 8, { width: PAGE_WIDTH, align: 'center' });

    doc.end();
  });
}

/**
 * Builds an official, itemized PDF sales receipt for ANY sales transaction.
 * Displays line items (products/goods: bags, shoes, etc.), quantities, unit prices,
 * subtotal, VAT/discounts, and grand total.
 */
export async function buildSalesReceiptPdf(data: SalesReceiptData): Promise<Buffer> {
  const logoBuffer = data.business.logoUrl ? await fetchLogoForPdf(data.business.logoUrl) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `Sales Receipt ${data.receiptNumber}`, Author: data.business.businessName },
    });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Top Accent Bar ──
    doc.rect(0, 0, doc.page.width, 6).fillColor(COLORS.headerBand).fill();

    // ── Header Section ──
    const HEADER_TOP = 45;
    const LEFT_COL_WIDTH = 290;
    const RIGHT_COL_WIDTH = 185;
    const RIGHT_COL_X = RIGHT - RIGHT_COL_WIDTH;

    // Logo (if available)
    const LOGO_SIZE = 44;
    let textStartX = LEFT;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, LEFT, HEADER_TOP, { fit: [LOGO_SIZE, LOGO_SIZE] });
        textStartX = LEFT + LOGO_SIZE + 10;
      } catch {
        textStartX = LEFT;
      }
    }

    const leftColWidthAdjusted = LEFT_COL_WIDTH - (textStartX - LEFT);

    // Left Column: Business Details
    let leftY = HEADER_TOP;
    doc.fillColor(COLORS.ink).fontSize(14).font(FONT.bold);
    doc.text(data.business.businessName, textStartX, leftY, { width: leftColWidthAdjusted });
    leftY += doc.heightOfString(data.business.businessName, { width: leftColWidthAdjusted }) + 3;

    doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.regular);
    doc.text(`Merchant ID: ${data.business.merchantId}`, textStartX, leftY, { width: leftColWidthAdjusted });
    leftY += 12;

    if (data.business.taxId) {
      doc.text(`Tax ID (TIN): ${data.business.taxId}`, textStartX, leftY, { width: leftColWidthAdjusted });
      leftY += 12;
    }
    if (data.business.address) {
      doc.text(data.business.address, textStartX, leftY, { width: leftColWidthAdjusted });
      leftY += doc.heightOfString(data.business.address, { width: leftColWidthAdjusted }) + 3;
    }

    // Right Column: Title, Receipt #, Date, Status
    let rightY = HEADER_TOP;
    doc.fillColor(COLORS.ink).fontSize(14).font(FONT.bold)
      .text('OFFICIAL SALES RECEIPT', RIGHT_COL_X, rightY, { width: RIGHT_COL_WIDTH, align: 'right' });
    rightY += 18;

    doc.fillColor(COLORS.muted).fontSize(8.5).font(FONT.regular)
      .text(`Receipt #: ${data.receiptNumber}`, RIGHT_COL_X, rightY, { width: RIGHT_COL_WIDTH, align: 'right' });
    rightY += 12;

    doc.text(`Date: ${formatDateTime(data.transactionDate)}`, RIGHT_COL_X, rightY, { width: RIGHT_COL_WIDTH, align: 'right' });
    rightY += 16;

    // Status Pill on Right
    const pillText = 'PAID IN FULL';
    doc.fontSize(8).font(FONT.bold);
    const pillW = doc.widthOfString(pillText) + 16;
    const pillX = RIGHT - pillW;
    doc.roundedRect(pillX, rightY, pillW, 16, 8).fillColor('#16a34a').fill();
    doc.fillColor('#ffffff').text(pillText, pillX, rightY + 4, { width: pillW, align: 'center' });
    rightY += 22;

    // ── Divider ──
    const dividerY = Math.max(leftY, rightY) + 12;
    doc.strokeColor(COLORS.hairline).lineWidth(1).moveTo(LEFT, dividerY).lineTo(RIGHT, dividerY).stroke();

    // ── Customer & Payment Summary Band ──
    const bandY = dividerY + 14;
    const bandColW = (PAGE_WIDTH - 20) / 2;

    // Left: Customer details
    const custY = bandY + 8;
    doc.roundedRect(LEFT, bandY, bandColW, 58, RADIUS).fillAndStroke(COLORS.panel, COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(7.5).font(FONT.bold).text('SOLD TO / CUSTOMER', LEFT + 12, custY);
    doc.fillColor(COLORS.ink).fontSize(10).font(FONT.bold)
      .text(data.customerName || 'Walk-in Customer / Direct Sale', LEFT + 12, custY + 12, { width: bandColW - 24, ellipsis: true });
    
    let custContact = '';
    if (data.customerPhone) custContact += data.customerPhone;
    if (data.customerEmail) custContact += (custContact ? ' • ' : '') + data.customerEmail;
    doc.fillColor(COLORS.muted).fontSize(8).font(FONT.regular)
      .text(custContact || 'Direct retail customer', LEFT + 12, custY + 28, { width: bandColW - 24, ellipsis: true });

    // Right: Payment & Method details
    const payColX = LEFT + bandColW + 20;
    doc.roundedRect(payColX, bandY, bandColW, 58, RADIUS).fillAndStroke(COLORS.panel, COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(7.5).font(FONT.bold).text('PAYMENT INFORMATION', payColX + 12, custY);
    doc.fillColor(COLORS.ink).fontSize(9.5).font(FONT.bold)
      .text(`Method: ${data.sourceLabel}`, payColX + 12, custY + 12, { width: bandColW - 24, ellipsis: true });
    
    let refLine = `Ref: ${data.transactionReference || 'N/A'}`;
    if (data.invoiceNumber) refLine += ` • Inv: ${data.invoiceNumber}`;
    doc.fillColor(COLORS.muted).fontSize(8).font(FONT.regular)
      .text(refLine, payColX + 12, custY + 28, { width: bandColW - 24, ellipsis: true });

    // ── Line Items Table ──
    const tableTop = bandY + 70;
    const colDesc = LEFT;
    const colQty = 315;
    const colUnit = 360;
    const colTotal = 445;
    const qtyW = 45;
    const unitW = 85;
    const totalW = 100;
    const descColWidth = colQty - colDesc - 20;
    const rowPadY = 6;

    // Table Header
    doc.roundedRect(LEFT, tableTop, PAGE_WIDTH, 22, RADIUS).fillColor(COLORS.headerBand).fill();
    doc.rect(LEFT, tableTop + RADIUS, PAGE_WIDTH, 22 - RADIUS).fillColor(COLORS.headerBand).fill();

    doc.fillColor(COLORS.onAccent).fontSize(8).font(FONT.bold);
    doc.text('ITEM / DESCRIPTION', colDesc + 12, tableTop + 7, { width: descColWidth });
    doc.text('QTY', colQty, tableTop + 7, { width: qtyW, align: 'right' });
    doc.text('UNIT PRICE', colUnit, tableTop + 7, { width: unitW, align: 'right' });
    doc.text('AMOUNT', colTotal, tableTop + 7, { width: totalW, align: 'right' });

    let y = tableTop + 22;

    data.items.forEach((line, idx) => {
      doc.fontSize(8.5).font(FONT.regular);
      const descHeight = doc.heightOfString(line.name, { width: descColWidth });
      const rowHeight = Math.max(22, descHeight + rowPadY * 2);

      if (y + rowHeight > 700) {
        doc.addPage();
        y = 50;
      }

      if (idx % 2 === 0) {
        doc.rect(LEFT, y, PAGE_WIDTH, rowHeight).fillColor(COLORS.panel).fill();
      }

      const textY = y + rowPadY;
      doc.fillColor(COLORS.ink).font(FONT.regular).fontSize(8.5);
      doc.text(line.name, colDesc + 12, textY, { width: descColWidth });
      doc.text(formatQty(line.quantity), colQty, textY, { width: qtyW, align: 'right' });
      doc.text(formatMoney(line.unitPrice), colUnit, textY, { width: unitW, align: 'right' });
      doc.fillColor(COLORS.ink).font(FONT.bold);
      doc.text(formatMoney(line.lineTotal), colTotal, textY, { width: totalW, align: 'right' });

      y += rowHeight;
    });

    // ── Table Bottom Line ──
    doc.strokeColor(COLORS.hairline).lineWidth(0.5).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
    y += 10;

    // ── Totals Section ──
    const totalsW = 230;
    const totalsX = RIGHT - totalsW;
    const totalsLabelW = 100;
    const totalsValW = totalsW - totalsLabelW;

    const addTotalLine = (label: string, value: string, isBold = false, color = COLORS.ink) => {
      doc.fontSize(8.5).font(isBold ? FONT.bold : FONT.regular).fillColor(COLORS.muted);
      doc.text(label, totalsX, y, { width: totalsLabelW, align: 'left' });
      doc.font(isBold ? FONT.bold : FONT.regular).fillColor(color);
      doc.text(value, totalsX + totalsLabelW, y, { width: totalsValW, align: 'right' });
      y += 15;
    };

    addTotalLine('Subtotal', formatMoney(data.subtotal));
    if (data.discount && data.discount > 0) {
      addTotalLine('Discount', `−${formatMoney(data.discount)}`, false, COLORS.danger);
    }
    if (data.vatAmount && data.vatAmount > 0) {
      addTotalLine(`VAT (${data.vatRate || 7.5}%)`, formatMoney(data.vatAmount));
    }

    // Grand Total Bar
    y += 4;
    doc.roundedRect(totalsX - 8, y, totalsW + 8, 26, RADIUS).fillColor(COLORS.headerBand).fill();
    doc.fillColor(COLORS.onAccent).fontSize(9).font(FONT.bold);
    doc.text('TOTAL PAID', totalsX, y + 8, { width: totalsLabelW, align: 'left' });
    doc.fontSize(11).font(FONT.bold);
    doc.text(formatMoney(data.amount), totalsX + totalsLabelW, y + 7, { width: totalsValW, align: 'right' });

    y += 42;

    // ── Thank you & Policy Note ──
    doc.roundedRect(LEFT, y, PAGE_WIDTH, 42, RADIUS).fillAndStroke(COLORS.panel, COLORS.hairline);
    doc.fillColor(COLORS.muted).fontSize(7.5).font(FONT.bold)
      .text('CUSTOMER RECEIPT & TAX NOTICE', LEFT + 12, y + 7);
    doc.fillColor(COLORS.body).fontSize(7.5).font(FONT.regular);
    doc.text(
      'Thank you for your business! Goods sold are subject to store exchange policy. This sales transaction has been electronically recorded in the merchant\'s accounts for Nigerian FIRS tax compliance.',
      LEFT + 12,
      y + 18,
      { width: PAGE_WIDTH - 24, lineGap: 1.5 }
    );

    // ── Footer ──
    const footerY = 760;
    doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).strokeColor(COLORS.hairline).stroke();
    doc.fillColor(COLORS.faint).fontSize(7).font(FONT.regular)
      .text('Powered by PayMyTax by WallX • https://paymytax.com • Official Electronic Sales Receipt', LEFT, footerY + 8, { width: PAGE_WIDTH, align: 'center' });

    doc.end();
  });
}
