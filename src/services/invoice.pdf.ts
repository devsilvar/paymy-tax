import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';
import { config } from '@/config';

// ─── Helpers ────────────────────────────────────────────────

function toNumber(v: Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : v.toNumber();
}

function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${symbol}${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank Transfer',
  pos: 'POS',
  card: 'Card',
  mobile_money: 'Mobile Money',
  cheque: 'Cheque',
  online: 'Online',
  other: 'Other',
};

function paymentMethodLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

function statusColor(status: string): string {
  switch (status) {
    case 'paid':
      return '#15803d'; // green
    case 'sent':
      return '#1d4ed8'; // blue
    case 'overdue':
      return '#b91c1c'; // red
    case 'cancelled':
      return '#6b7280'; // gray
    case 'draft':
    default:
      return '#a16207'; // amber
  }
}

// ─── Types ──────────────────────────────────────────────────

interface InvoiceForPdf {
  invoiceNumber: string;
  status: string;
  issueDate: Date;
  dueDate: Date;
  paidAt: Date | null;
  paymentMethod: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  customerTaxId: string | null;
  subtotal: Decimal | number;
  vatRate: Decimal | number;
  vatAmount: Decimal | number;
  discount: Decimal | number;
  total: Decimal | number;
  currency: string;
  notes: string | null;
  paymentTerms: string | null;
  lines: Array<{
    description: string;
    quantity: Decimal | number;
    unitPrice: Decimal | number;
    lineTotal: Decimal | number;
  }>;
}

interface BusinessForPdf {
  businessName: string;
  merchantId: string;
  ownerName: string;
  taxId: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}

// ─── Builder ────────────────────────────────────────────────

/**
 * Render an A4 invoice PDF as a Buffer.
 *
 * Layout is two-column at the top (business left, invoice meta right),
 * a bill-to block, a line-items table, a totals column on the right,
 * and notes/terms at the bottom. Matches a standard commercial invoice
 * that a Nigerian SME customer would expect to receive by email.
 */
export function buildInvoicePdf(
  business: BusinessForPdf,
  invoice: InvoiceForPdf,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const LEFT = 50;
    const RIGHT = 545;
    const PAGE_WIDTH = RIGHT - LEFT;

    // ── Top band: business (left) + INVOICE label (right) ──
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .fillColor('#111111')
      .text(business.businessName, LEFT, 50, { width: 300 });

    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#555555');
    const bizLines: string[] = [];
    if (business.ownerName) bizLines.push(business.ownerName);
    const locParts = [business.address, business.city, business.state].filter(Boolean);
    if (locParts.length) bizLines.push(locParts.join(', '));
    if (business.taxId) bizLines.push(`TIN: ${business.taxId}`);
    bizLines.push(`Merchant ID: ${business.merchantId}`);
    bizLines.forEach((line, i) => doc.text(line, LEFT, 78 + i * 12, { width: 300 }));

    // Right side: INVOICE heading + number + status badge
    doc
      .fontSize(26)
      .font('Helvetica-Bold')
      .fillColor('#111111')
      .text('INVOICE', 380, 50, { width: 165, align: 'right' });

    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#555555')
      .text(invoice.invoiceNumber, 380, 80, { width: 165, align: 'right' });

    // Status pill
    const statusText = statusLabel(invoice.status).toUpperCase();
    const pillColor = statusColor(invoice.status);
    const pillWidth = doc.widthOfString(statusText) + 16;
    const pillX = RIGHT - pillWidth;
    const pillY = 98;
    doc
      .roundedRect(pillX, pillY, pillWidth, 16, 8)
      .fillColor(pillColor)
      .fill();
    doc
      .fillColor('#ffffff')
      .fontSize(8)
      .font('Helvetica-Bold')
      .text(statusText, pillX, pillY + 4, { width: pillWidth, align: 'center' });

    // ── Divider ──
    doc
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .moveTo(LEFT, 150)
      .lineTo(RIGHT, 150)
      .stroke();

    // ── Bill To (left) + Dates (right) ──
    const metaY = 165;
    doc
      .fontSize(8)
      .font('Helvetica-Bold')
      .fillColor('#6b7280')
      .text('BILL TO', LEFT, metaY);

    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#111111')
      .text(invoice.customerName, LEFT, metaY + 12, { width: 260 });

    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#374151');
    const custLines: string[] = [];
    if (invoice.customerAddress) custLines.push(invoice.customerAddress);
    if (invoice.customerEmail) custLines.push(invoice.customerEmail);
    if (invoice.customerPhone) custLines.push(invoice.customerPhone);
    if (invoice.customerTaxId) custLines.push(`TIN: ${invoice.customerTaxId}`);
    custLines.forEach((l, i) => doc.text(l, LEFT, metaY + 26 + i * 12, { width: 260 }));

    // Right-side date block
    const dateX = 380;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('ISSUE DATE', dateX, metaY, { width: 165, align: 'right' });
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#111111')
      .text(formatDate(invoice.issueDate), dateX, metaY + 12, { width: 165, align: 'right' });

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('DUE DATE', dateX, metaY + 30, { width: 165, align: 'right' });
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#111111')
      .text(formatDate(invoice.dueDate), dateX, metaY + 42, { width: 165, align: 'right' });

    if (invoice.paidAt) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
      doc.text('PAID ON', dateX, metaY + 60, { width: 165, align: 'right' });
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#15803d')
        .text(formatDate(invoice.paidAt), dateX, metaY + 72, { width: 165, align: 'right' });

      const methodLabel = paymentMethodLabel(invoice.paymentMethod);
      if (methodLabel) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
        doc.text('PAYMENT METHOD', dateX, metaY + 90, { width: 165, align: 'right' });
        doc
          .fontSize(10)
          .font('Helvetica')
          .fillColor('#111111')
          .text(methodLabel, dateX, metaY + 102, { width: 165, align: 'right' });
      }
    }

    // ── Line items table ──
    const tableTop = 270;
    const colDesc = LEFT;
    const colQty = 330;
    const colUnit = 390;
    const colTotal = 470;

    // Table header band
    doc.rect(LEFT, tableTop, PAGE_WIDTH, 22).fillColor('#111827').fill();
    doc
      .fillColor('#ffffff')
      .fontSize(9)
      .font('Helvetica-Bold');
    doc.text('DESCRIPTION', colDesc + 10, tableTop + 7, { width: colQty - colDesc - 10 });
    doc.text('QTY', colQty, tableTop + 7, { width: 50, align: 'right' });
    doc.text('UNIT PRICE', colUnit, tableTop + 7, { width: 70, align: 'right' });
    doc.text('AMOUNT', colTotal, tableTop + 7, { width: 65, align: 'right' });

    // Rows
    let y = tableTop + 30;
    doc.fillColor('#111111').fontSize(9).font('Helvetica');

    invoice.lines.forEach((line, idx) => {
      // Page break if needed (leave room for totals)
      if (y > 650) {
        doc.addPage();
        y = 50;
      }

      if (idx % 2 === 0) {
        doc.rect(LEFT, y - 4, PAGE_WIDTH, 22).fillColor('#f9fafb').fill();
      }

      const qty = toNumber(line.quantity);
      const unit = toNumber(line.unitPrice);
      const total = toNumber(line.lineTotal);

      doc.fillColor('#111111').font('Helvetica');
      doc.text(line.description, colDesc + 10, y, { width: colQty - colDesc - 20 });
      doc.text(qty.toString(), colQty, y, { width: 50, align: 'right' });
      doc.text(formatMoney(unit, invoice.currency), colUnit, y, { width: 70, align: 'right' });
      doc.text(formatMoney(total, invoice.currency), colTotal, y, { width: 65, align: 'right' });

      y += 22;
    });

    // ── Totals block (right-aligned) ──
    y += 10;
    const totalsX = 360;
    const totalsValueX = 470;
    const totalsWidth = 65;

    const subtotal = toNumber(invoice.subtotal);
    const discount = toNumber(invoice.discount);
    const vatRate = toNumber(invoice.vatRate);
    const vatAmount = toNumber(invoice.vatAmount);
    const total = toNumber(invoice.total);

    doc
      .strokeColor('#e5e7eb')
      .lineWidth(0.5)
      .moveTo(totalsX, y)
      .lineTo(RIGHT, y)
      .stroke();
    y += 8;

    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    doc.text('Subtotal', totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
    doc.text(formatMoney(subtotal, invoice.currency), totalsValueX, y, { width: totalsWidth, align: 'right' });
    y += 16;

    if (discount > 0) {
      doc.fillColor('#374151');
      doc.text('Discount', totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
      doc.text(`-${formatMoney(discount, invoice.currency)}`, totalsValueX, y, { width: totalsWidth, align: 'right' });
      y += 16;
    }

    doc.fillColor('#374151');
    doc.text(`VAT (${vatRate}%)`, totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
    doc.text(formatMoney(vatAmount, invoice.currency), totalsValueX, y, { width: totalsWidth, align: 'right' });
    y += 12;

    doc
      .strokeColor('#111827')
      .lineWidth(1)
      .moveTo(totalsX, y)
      .lineTo(RIGHT, y)
      .stroke();
    y += 8;

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#111111');
    doc.text('TOTAL', totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
    doc.text(formatMoney(total, invoice.currency), totalsValueX, y, { width: totalsWidth, align: 'right' });
    y += 24;

    // ── Notes & payment terms ──
    if (invoice.notes || invoice.paymentTerms) {
      y += 12;
      if (y > 720) {
        doc.addPage();
        y = 50;
      }

      if (invoice.paymentTerms) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
        doc.text('PAYMENT TERMS', LEFT, y);
        y += 12;
        doc.fontSize(9).font('Helvetica').fillColor('#374151');
        doc.text(invoice.paymentTerms, LEFT, y, { width: 480 });
        y = doc.y + 8;
      }

      if (invoice.notes) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
        doc.text('NOTES', LEFT, y);
        y += 12;
        doc.fontSize(9).font('Helvetica').fillColor('#374151');
        doc.text(invoice.notes, LEFT, y, { width: 480 });
      }
    }

    // ── Footer ──
    const footerY = 780;
    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#9ca3af')
      .text(
        `Generated by PayMyTax by WallX  •  Tax Authority: ${config.tax.taxAuthority}  •  VAT shown separately per FIRS standard`,
        LEFT,
        footerY,
        { width: PAGE_WIDTH, align: 'center' },
      );
    doc.text(
      'This is a computer-generated document and does not require a signature.',
      LEFT,
      footerY + 10,
      { width: PAGE_WIDTH, align: 'center' },
    );

    doc.end();
  });
}
