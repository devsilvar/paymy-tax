import PDFDocument from 'pdfkit';
import { fetchLogoForPdf } from '@/lib/pdf-utils';
import {
  COLORS,
  FONT,
  LEFT,
  RIGHT,
  PAGE_WIDTH,
  RADIUS,
  formatMoney,
  formatDateTime,
  formatQty,
} from './receipt-common.pdf';

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
