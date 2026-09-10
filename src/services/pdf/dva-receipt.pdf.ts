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
} from './receipt-common.pdf';

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
