/**
 * Sales Report PDF — A4 tabular report of all sales in a date range.
 * Follows the same PDFKit patterns as tax-slip.pdf.ts and invoice.pdf.ts.
 */
import PDFDocument from 'pdfkit';
import { COLORS, FONT, LEFT, RIGHT, PAGE_WIDTH, formatMoney, formatDate } from './receipt-common.pdf';
import { config } from '@/config';

export interface SalesReportRow {
  date: Date | string;
  description: string | null;
  source: string;
  customerName: string | null;
  amount: number;
  status: string;
}

export interface SalesReportData {
  businessName: string;
  merchantId: string;
  logoBuffer: Buffer | null;
  from: string; // YYYY-MM-DD
  to: string;
  rows: SalesReportRow[];
  totalAmount: number;
  breakdown: Record<string, { count: number; total: number }>;
}

const SOURCE_LABELS: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  manual: 'Manual',
  cash: 'Cash',
  pos: 'POS',
  invoice: 'Invoice',
  online_store: 'Online',
  paycode: 'Paycode',
};

export async function buildSalesReportPdf(data: SalesReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Sales Report ${data.from} to ${data.to}`,
        Author: 'PMT by Wallx',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header ──────────────────────────────────────────────
    if (data.logoBuffer) {
      try { doc.image(data.logoBuffer, LEFT, 45, { width: 50 }); } catch { /* skip */ }
    }

    const headerX = data.logoBuffer ? LEFT + 60 : LEFT;
    doc.font(FONT.bold).fontSize(16).fillColor(COLORS.ink)
      .text(data.businessName, headerX, 50);
    doc.font(FONT.regular).fontSize(8).fillColor(COLORS.muted)
      .text(`ID: ${data.merchantId}`, headerX, 70);

    doc.font(FONT.bold).fontSize(12).fillColor(COLORS.ink)
      .text('Sales Report', RIGHT - 130, 50, { width: 130, align: 'right' });
    doc.font(FONT.regular).fontSize(8).fillColor(COLORS.muted)
      .text(`${formatDate(data.from)} — ${formatDate(data.to)}`, RIGHT - 130, 66, { width: 130, align: 'right' });

    doc.moveTo(LEFT, 90).lineTo(RIGHT, 90).strokeColor(COLORS.hairline).lineWidth(1).stroke();

    // ── Summary Strip ───────────────────────────────────────
    let y = 100;
    doc.font(FONT.bold).fontSize(9).fillColor(COLORS.ink).text('Summary', LEFT, y);
    y += 16;

    doc.font(FONT.regular).fontSize(8).fillColor(COLORS.body);
    doc.text(`Total Sales: ${data.rows.length} transactions`, LEFT, y);
    doc.text(`Total Amount: ${formatMoney(data.totalAmount)}`, LEFT + 200, y);
    y += 14;

    // Breakdown by source
    const sources = Object.entries(data.breakdown).filter(([, v]) => v.count > 0);
    if (sources.length > 0) {
      let bx = LEFT;
      for (const [source, info] of sources) {
        const label = SOURCE_LABELS[source] || source;
        doc.font(FONT.regular).fontSize(7).fillColor(COLORS.muted)
          .text(`${label}: ${info.count} (${formatMoney(info.total)})`, bx, y);
        bx += 130;
        if (bx > RIGHT - 50) { bx = LEFT; y += 12; }
      }
      y += 14;
    }

    doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(COLORS.hairline).lineWidth(0.5).stroke();
    y += 10;

    // ── Table Header ────────────────────────────────────────
    const COL = { date: LEFT, desc: LEFT + 75, source: LEFT + 250, customer: LEFT + 330, amount: RIGHT };

    doc.font(FONT.bold).fontSize(7).fillColor(COLORS.muted);
    doc.text('DATE', COL.date, y, { width: 70 });
    doc.text('DESCRIPTION', COL.desc, y, { width: 170 });
    doc.text('SOURCE', COL.source, y, { width: 75 });
    doc.text('CUSTOMER', COL.customer, y, { width: 80 });
    doc.text('AMOUNT', COL.amount - 80, y, { width: 80, align: 'right' });
    y += 14;

    doc.moveTo(LEFT, y - 2).lineTo(RIGHT, y - 2).strokeColor(COLORS.hairline).lineWidth(0.5).stroke();

    // ── Table Rows ──────────────────────────────────────────
    for (let i = 0; i < data.rows.length; i++) {
      if (y > 750) {
        doc.addPage();
        y = 50;
      }

      const row = data.rows[i];
      const bg = i % 2 === 0 ? '#ffffff' : COLORS.panel;
      doc.rect(LEFT - 4, y - 2, PAGE_WIDTH + 8, 16).fill(bg);

      doc.font(FONT.regular).fontSize(7).fillColor(COLORS.body);
      doc.text(formatDate(row.date), COL.date, y, { width: 70 });
      doc.text((row.description || '—').substring(0, 45), COL.desc, y, { width: 170 });
      doc.font(FONT.regular).fontSize(7).fillColor(COLORS.muted);
      doc.text(SOURCE_LABELS[row.source] || row.source, COL.source, y, { width: 75 });
      doc.text((row.customerName || '—').substring(0, 20), COL.customer, y, { width: 80 });
      doc.font(FONT.bold).fontSize(7).fillColor(COLORS.ink);
      doc.text(formatMoney(row.amount), COL.amount - 80, y, { width: 80, align: 'right' });

      y += 16;
    }

    if (data.rows.length === 0) {
      doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted)
        .text('No sales transactions found in this period.', LEFT, y + 20, { width: PAGE_WIDTH, align: 'center' });
      y += 50;
    }

    // ── Total Bar ───────────────────────────────────────────
    y += 4;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(COLORS.ink).lineWidth(1).stroke();
    y += 8;
    doc.font(FONT.bold).fontSize(9).fillColor(COLORS.ink)
      .text('TOTAL', LEFT, y);
    doc.text(formatMoney(data.totalAmount), COL.amount - 100, y, { width: 100, align: 'right' });

    // ── Footer ──────────────────────────────────────────────
    const footerY = doc.page.height - 40;
    doc.font(FONT.regular).fontSize(6).fillColor(COLORS.faint)
      .text(
        `PMT by Wallx • ${config.tax.taxAuthority} • Generated: ${new Date().toLocaleDateString('en-NG')}`,
        LEFT, footerY, { width: PAGE_WIDTH, align: 'center' }
      );

    doc.end();
  });
}
