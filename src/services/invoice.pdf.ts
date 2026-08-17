import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';
import { config } from '@/config';

// ─── Design tokens ──────────────────────────────────────────
// Cool, crisp, minimal palette — slate/ink text, indigo accent,
// soft gray hairlines, generous whitespace.

const COLORS = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  hairline: '#e2e8f0',
  panel: '#f8fafc',
  accent: '#4f46e5',
  headerBand: '#0f172a',
  onAccent: '#ffffff',
  success: '#16a34a',
  info: '#2563eb',
  danger: '#dc2626',
  neutral: '#6b7280',
  warn: '#b45309',
};

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
};

const LEFT = 50;
const RIGHT = 545;
const PAGE_WIDTH = RIGHT - LEFT;
const RADIUS = 6;

// ─── Helpers ────────────────────────────────────────────────

function toNumber(v: Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : v.toNumber();
}

// IMPORTANT: 'Helvetica' is one of PDF's 14 built-in standard fonts.
// Its character set (WinAnsi) does NOT include the Naira sign (₦, U+20A6),
// so pdfkit/PDF viewers render it as a broken/missing-glyph mark instead
// of the symbol. Rather than silently render garbage, we spell the
// currency out — this is correct with zero font dependencies. If you
// later embed a Unicode-complete TTF (e.g. via doc.registerFont with a
// Noto Sans file), you can switch this back to the ₦ glyph safely.
function formatMoney(amount: number, currency: string): string {
  const prefix = currency === 'NGN' ? 'NGN ' : `${currency} `;
  return `${prefix}${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? qty.toString() : qty.toLocaleString('en-NG', { maximumFractionDigits: 2 });
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
      return COLORS.success;
    case 'sent':
      return COLORS.info;
    case 'overdue':
      return COLORS.danger;
    case 'cancelled':
      return COLORS.neutral;
    case 'draft':
    default:
      return COLORS.warn;
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

// ─── Flow-layout primitives ────────────────────────────────
// The old layout used hardcoded y-offsets for every line, which breaks
// the moment any field wraps to more than one line (long business name,
// long address, etc). These helpers measure text height with pdfkit's
// heightOfString (a pure measurement call, no drawing) BEFORE anything
// is drawn, so every block that follows is positioned off the *actual*
// height of the block before it — never a guess.

interface BlockItem {
  text: string;
  size: number;
  font: string;
  width: number;
  align?: 'left' | 'right';
  color?: string;
  gapAfter?: number;
  characterSpacing?: number;
}

function measureBlock(doc: PDFKit.PDFDocument, items: BlockItem[]): number {
  let h = 0;
  for (const it of items) {
    doc.fontSize(it.size).font(it.font);
    h += doc.heightOfString(it.text, { width: it.width }) + (it.gapAfter ?? 0);
  }
  return h;
}

function drawBlock(doc: PDFKit.PDFDocument, items: BlockItem[], x: number, startY: number): number {
  let y = startY;
  for (const it of items) {
    doc.fontSize(it.size).font(it.font).fillColor(it.color ?? COLORS.ink);
    doc.text(it.text, x, y, {
      width: it.width,
      align: it.align ?? 'left',
      characterSpacing: it.characterSpacing,
    });
    y += doc.heightOfString(it.text, { width: it.width }) + (it.gapAfter ?? 0);
  }
  return y;
}

// ─── Builder ────────────────────────────────────────────────

/**
 * Render an A4 invoice PDF as a Buffer.
 *
 * Every section's vertical position is derived from measuring the
 * section above it, so long business names, long addresses, or an
 * extra "paid on / payment method" row never overlap the next section
 * — the layout reflows instead of colliding.
 */
export function buildInvoicePdf(
  business: BusinessForPdf,
  invoice: InvoiceForPdf,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Top accent bar ──
    doc.rect(0, 0, doc.page.width, 6).fillColor(COLORS.accent).fill();

    // ── Header: business (left) + INVOICE (right) ──
    const HEADER_TOP = 50;
    const LEFT_COL_WIDTH = 300;
    const RIGHT_COL_X = 380;
    const RIGHT_COL_WIDTH = 165;

    const bizLines: string[] = [];
    if (business.ownerName) bizLines.push(business.ownerName);
    const locParts = [business.address, business.city, business.state].filter(Boolean);
    if (locParts.length) bizLines.push(locParts.join(', '));
    if (business.taxId) bizLines.push(`TIN: ${business.taxId}`);
    bizLines.push(`Merchant ID: ${business.merchantId}`);

    const leftHeaderItems: BlockItem[] = [
      { text: business.businessName, size: 20, font: FONT.bold, width: LEFT_COL_WIDTH, color: COLORS.ink, gapAfter: 8 },
      ...bizLines.map((line): BlockItem => ({
        text: line,
        size: 9,
        font: FONT.regular,
        width: LEFT_COL_WIDTH,
        color: COLORS.body,
        gapAfter: 3,
      })),
    ];
    const leftHeaderBottom = HEADER_TOP + drawBlockDryRun(doc, leftHeaderItems);
    drawBlock(doc, leftHeaderItems, LEFT, HEADER_TOP);

    const rightHeaderItems: BlockItem[] = [
      { text: 'INVOICE', size: 22, font: FONT.bold, width: RIGHT_COL_WIDTH, align: 'right', color: COLORS.ink, gapAfter: 8, characterSpacing: 0.5 },
      { text: invoice.invoiceNumber, size: 10, font: FONT.regular, width: RIGHT_COL_WIDTH, align: 'right', color: COLORS.muted, gapAfter: 10 },
    ];
    const afterInvoiceNum = drawBlock(doc, rightHeaderItems, RIGHT_COL_X, HEADER_TOP);

    // Status pill, right after the invoice number block
    const statusText = statusLabel(invoice.status).toUpperCase();
    const pillColor = statusColor(invoice.status);
    doc.fontSize(8).font(FONT.bold);
    const pillWidth = doc.widthOfString(statusText, { characterSpacing: 0.3 }) + 18;
    const pillX = RIGHT - pillWidth;
    const pillY = afterInvoiceNum;
    doc.roundedRect(pillX, pillY, pillWidth, 17, 8.5).fillColor(pillColor).fill();
    doc
      .fillColor(COLORS.onAccent)
      .text(statusText, pillX, pillY + 4.5, { width: pillWidth, align: 'center', characterSpacing: 0.3 });
    const rightHeaderBottom = pillY + 17;

    // ── Divider — placed below whichever header column is taller ──
    const dividerY = Math.max(leftHeaderBottom, rightHeaderBottom) + 14;
    doc.strokeColor(COLORS.hairline).lineWidth(1).moveTo(LEFT, dividerY).lineTo(RIGHT, dividerY).stroke();

    // ── Bill To / Dates band — height derived from actual content ──
    const bandTop = dividerY + 16;
    const padX = 18;
    const padY = 16;
    const custColWidth = 250;
    const dateColWidth = 90;
    const col1X = 330;
    const col2X = 455;

    const custLines: string[] = [];
    if (invoice.customerAddress) custLines.push(invoice.customerAddress);
    if (invoice.customerEmail) custLines.push(invoice.customerEmail);
    if (invoice.customerPhone) custLines.push(invoice.customerPhone);
    if (invoice.customerTaxId) custLines.push(`TIN: ${invoice.customerTaxId}`);

    const leftBandItems: BlockItem[] = [
      { text: 'BILL TO', size: 7.5, font: FONT.bold, width: custColWidth, color: COLORS.muted, gapAfter: 4, characterSpacing: 0.4 },
      { text: invoice.customerName, size: 11, font: FONT.bold, width: custColWidth, color: COLORS.ink, gapAfter: 6 },
      ...custLines.map((l): BlockItem => ({ text: l, size: 9, font: FONT.regular, width: custColWidth, color: COLORS.body, gapAfter: 3 })),
    ];
    const leftBandHeight = measureBlock(doc, leftBandItems);

    // Right side: issue/due date always present; paid-on/method only if paid.
    // Each "label + value" pair's height is measured the same way, so
    // adding the paid-on/method rows never collides with anything below.
    const dateRow = (label: string, value: string, color = COLORS.ink): BlockItem[] => [
      { text: label.toUpperCase(), size: 7.5, font: FONT.bold, width: dateColWidth, align: 'right', color: COLORS.muted, gapAfter: 2, characterSpacing: 0.4 },
      { text: value, size: 10, font: FONT.regular, width: dateColWidth, align: 'right', color, gapAfter: 12 },
    ];

    const col1Items: BlockItem[] = [...dateRow('Issue Date', formatDate(invoice.issueDate))];
    const col2Items: BlockItem[] = [...dateRow('Due Date', formatDate(invoice.dueDate))];
    if (invoice.paidAt) {
      col1Items.push(...dateRow('Paid On', formatDate(invoice.paidAt), COLORS.success));
      const methodLabel = paymentMethodLabel(invoice.paymentMethod);
      if (methodLabel) col2Items.push(...dateRow('Method', methodLabel));
    }
    const rightBandHeight = Math.max(measureBlock(doc, col1Items), measureBlock(doc, col2Items));

    const bandContentHeight = Math.max(leftBandHeight, rightBandHeight);
    const bandHeight = padY * 2 + bandContentHeight - (leftBandItems[leftBandItems.length - 1].gapAfter ?? 0);

    doc.roundedRect(LEFT, bandTop, PAGE_WIDTH, bandHeight, RADIUS).fillColor(COLORS.panel).fill();
    drawBlock(doc, leftBandItems, LEFT + padX, bandTop + padY);
    drawBlock(doc, col1Items, col1X, bandTop + padY);
    drawBlock(doc, col2Items, col2X, bandTop + padY);

    // ── Line items table — starts safely below the (now correctly sized) band ──
    const tableTop = bandTop + bandHeight + 26;
    const colDesc = LEFT;
    // Amount/unit-price columns widened to fit "NGN 1,234,567.00"-style
    // values comfortably (the ₦ symbol doesn't render in Helvetica — see
    // formatMoney — so the printed string is longer than a bare "₦" prefix
    // would be, and columns need to be sized for that).
    const colQty = 315;
    const colUnit = 360;
    const colTotal = 445;
    const qtyW = 45;
    const unitW = 85;
    const totalW = 100;
    const rowPadY = 8;

    doc.roundedRect(LEFT, tableTop, PAGE_WIDTH, 24, RADIUS).fillColor(COLORS.headerBand).fill();
    doc.rect(LEFT, tableTop + RADIUS, PAGE_WIDTH, 24 - RADIUS).fillColor(COLORS.headerBand).fill();

    doc.fillColor(COLORS.onAccent).fontSize(8.5).font(FONT.bold);
    doc.text('DESCRIPTION', colDesc + 14, tableTop + 8, { width: colQty - colDesc - 14, characterSpacing: 0.3 });
    doc.text('QTY', colQty, tableTop + 8, { width: qtyW, align: 'right', characterSpacing: 0.3 });
    doc.text('UNIT PRICE', colUnit, tableTop + 8, { width: unitW, align: 'right', characterSpacing: 0.3 });
    doc.text('AMOUNT', colTotal, tableTop + 8, { width: totalW, align: 'right', characterSpacing: 0.3 });

    let y = tableTop + 24;
    const descColWidth = colQty - colDesc - 24;

    invoice.lines.forEach((line, idx) => {
      const qty = toNumber(line.quantity);
      const unit = toNumber(line.unitPrice);
      const total = toNumber(line.lineTotal);

      doc.fontSize(9).font(FONT.regular);
      const descHeight = doc.heightOfString(line.description, { width: descColWidth });
      const rowHeight = Math.max(22, descHeight + rowPadY * 2);

      if (y + rowHeight > 700) {
        doc.addPage();
        y = 50;
      }

      if (idx % 2 === 0) {
        doc.rect(LEFT, y, PAGE_WIDTH, rowHeight).fillColor(COLORS.panel).fill();
      }

      const textY = y + rowPadY;
      doc.fillColor(COLORS.ink).font(FONT.regular).fontSize(9);
      doc.text(line.description, colDesc + 14, textY, { width: descColWidth });
      doc.text(formatQty(qty), colQty, textY, { width: qtyW, align: 'right' });
      doc.text(formatMoney(unit, invoice.currency), colUnit, textY, { width: unitW, align: 'right' });
      doc.fillColor(COLORS.ink).font(FONT.bold);
      doc.text(formatMoney(total, invoice.currency), colTotal, textY, { width: totalW, align: 'right' });

      y += rowHeight;
    });

    doc.strokeColor(COLORS.hairline).lineWidth(1).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();

    // ── Totals block — value column aligned with the table's AMOUNT column ──
    y += 14;
    const totalsX = 330;
    const totalsValueX = colTotal; // 445 — same x as the table's amount column
    const totalsWidth = totalW; // 100 — wide enough for "NGN 1,234,567.00"

    const subtotal = toNumber(invoice.subtotal);
    const discount = toNumber(invoice.discount);
    const vatRate = toNumber(invoice.vatRate);
    const vatAmount = toNumber(invoice.vatAmount);
    const total = toNumber(invoice.total);

    doc.fontSize(9.5).font(FONT.regular).fillColor(COLORS.body);
    doc.text('Subtotal', totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
    doc.text(formatMoney(subtotal, invoice.currency), totalsValueX, y, { width: totalsWidth, align: 'right' });
    y += 18;

    if (discount > 0) {
      doc.fillColor(COLORS.body);
      doc.text('Discount', totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
      doc.text(`-${formatMoney(discount, invoice.currency)}`, totalsValueX, y, { width: totalsWidth, align: 'right' });
      y += 18;
    }

    doc.fillColor(COLORS.body);
    doc.text(`VAT (${vatRate}%)`, totalsX, y, { width: totalsValueX - totalsX - 5, align: 'right' });
    doc.text(formatMoney(vatAmount, invoice.currency), totalsValueX, y, { width: totalsWidth, align: 'right' });
    y += 14;

    const totalPanelY = y;
    const totalPanelHeight = 34;
    doc
      .roundedRect(totalsX - 12, totalPanelY, RIGHT - (totalsX - 12), totalPanelHeight, RADIUS)
      .fillColor(COLORS.ink)
      .fill();
    doc.fontSize(11).font(FONT.bold).fillColor(COLORS.onAccent);
    doc.text('TOTAL', totalsX, totalPanelY + 11, { width: totalsValueX - totalsX - 5, align: 'right' });
    doc.text(formatMoney(total, invoice.currency), totalsValueX, totalPanelY + 11, { width: totalsWidth, align: 'right' });
    y = totalPanelY + totalPanelHeight + 28;

    // ── Notes & payment terms ──
    if (invoice.notes || invoice.paymentTerms) {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }

      doc.strokeColor(COLORS.hairline).lineWidth(1).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
      y += 16;

      if (invoice.paymentTerms) {
        doc.fontSize(7.5).font(FONT.bold).fillColor(COLORS.muted);
        doc.text('PAYMENT TERMS', LEFT, y, { characterSpacing: 0.4 });
        y += 12;
        doc.fontSize(9).font(FONT.regular).fillColor(COLORS.body);
        doc.text(invoice.paymentTerms, LEFT, y, { width: 480 });
        y = doc.y + 12;
      }

      if (invoice.notes) {
        doc.fontSize(7.5).font(FONT.bold).fillColor(COLORS.muted);
        doc.text('NOTES', LEFT, y, { characterSpacing: 0.4 });
        y += 12;
        doc.fontSize(9).font(FONT.regular).fillColor(COLORS.body);
        doc.text(invoice.notes, LEFT, y, { width: 480 });
      }
    }

    // ── Footer on every page ──
    const pageRange = doc.bufferedPageRange();
    for (let i = 0; i < pageRange.count; i++) {
      doc.switchToPage(pageRange.start + i);
      const footerY = doc.page.height - 60;
      doc.strokeColor(COLORS.hairline).lineWidth(0.5).moveTo(LEFT, footerY - 12).lineTo(RIGHT, footerY - 12).stroke();
      doc
        .fontSize(7)
        .font(FONT.regular)
        .fillColor(COLORS.faint)
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
      if (pageRange.count > 1) {
        doc.text(`Page ${i + 1} of ${pageRange.count}`, LEFT, footerY + 20, { width: PAGE_WIDTH, align: 'center' });
      }
    }

    doc.end();
  });
}

// Measures a block's total height without drawing anything (thin wrapper
// kept separate from measureBlock's name for call-site clarity above).
function drawBlockDryRun(doc: PDFKit.PDFDocument, items: BlockItem[]): number {
  return measureBlock(doc, items);
}