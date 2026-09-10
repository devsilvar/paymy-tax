import PDFDocument from 'pdfkit';
import { fetchLogoForPdf } from '@/lib/pdf-utils';
import { config } from '@/config';
import {
  FONT,
  formatMoney,
  formatDate,
  formatMonthYear,
} from './receipt-common.pdf';
import { drawTaxSlipVerificationSeal } from './tax-slip-seal.pdf';

// ─── Design Tokens ──────────────────────────────────────────
const COLORS = {
  ink: '#0f172a',        // Slate 900
  body: '#334155',       // Slate 700
  muted: '#64748b',      // Slate 500
  faint: '#94a3b8',      // Slate 400
  hairline: '#e2e8f0',   // Slate 200
  panel: '#f8fafc',      // Slate 50
  panelBorder: '#cbd5e1',// Slate 300
  accent: '#4f46e5',     // Indigo 600
  accentDark: '#3730a3', // Indigo 800
  headerBand: '#1e1b4b', // Indigo 950
  onAccent: '#ffffff',
  success: '#15803d',    // Green 700
  successBg: '#f0fdf4',  // Green 50
  successBorder: '#bbf7d0',
  pending: '#b45309',    // Amber 700
  pendingBg: '#fffbeb',  // Amber 50
  pendingBorder: '#fde68a',
  blue: '#1d4ed8',       // Blue 700
  blueBg: '#eff6ff',     // Blue 50
  blueBorder: '#bfdbfe',
};

const LEFT = 45;
const RIGHT = 550;
const PAGE_WIDTH = RIGHT - LEFT;

// ─── Data Interface ─────────────────────────────────────────

export interface TaxSlipData {
  slipNumber: string;
  taxMonth: Date;
  generatedAt: Date;
  isFinalized: boolean;
  isLocked: boolean;
  paymentStatus: string;
  business: {
    businessName: string;
    merchantId: string;
    ownerName: string;
    taxId?: string | null;
    address?: string | null;
    email?: string | null;
    phone?: string | null;
    logoUrl?: string | null;
  };
  assessment: {
    totalSales: number;
    totalExpenses: number;
    grossProfit: number;
    taxRate: number;
    taxPayable: number;
    profitMargin?: number | null;
  };
  payment?: {
    paymentReference: string;
    paymentDate?: Date | null;
    paymentMethod?: string | null;
    amountPaid?: number | null;
    paymentStatus: string;
  } | null;
}

/**
 * Builds an official, publication-quality 1-page A4 PDF Monthly Tax Assessment Slip.
 */
export async function buildTaxSlipPdf(data: TaxSlipData): Promise<Buffer> {
  const logoBuffer = data.business.logoUrl ? await fetchLogoForPdf(data.business.logoUrl) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: LEFT,
      info: {
        Title: `Tax Assessment Slip - ${data.slipNumber}`,
        Author: 'PayMyTax by WallX',
        Subject: `FIRS SME Tax Assessment - ${formatMonthYear(data.taxMonth)}`,
        Keywords: 'Tax, FIRS, SME, Assessment Slip, Nigeria, PayMyTax',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = 35;

    // ── 1. Top Decorative Brand Bar ──────────────────────────
    doc.rect(LEFT, y, PAGE_WIDTH, 4).fill(COLORS.accent);
    y += 12;

    // ── 2. Header Section (Logo / Brand Left, Title Right) ──
    const headerTop = y;

    // Left: Logo & Company Identification
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, LEFT, y, { fit: [48, 48] });
      } catch {
        // Fallback without logo
      }
    }

    const brandX = logoBuffer ? LEFT + 56 : LEFT;
    doc
      .fillColor(COLORS.ink)
      .font(FONT.bold)
      .fontSize(16)
      .text('PayMyTax', brandX, y, { lineBreak: false });

    doc
      .fillColor(COLORS.accent)
      .font(FONT.bold)
      .fontSize(9)
      .text(' BY WALLX', brandX + 78, y + 5, { lineBreak: false });

    doc
      .fillColor(COLORS.muted)
      .font(FONT.regular)
      .fontSize(8)
      .text('Federal Inland Revenue Service (FIRS) SME Compliance Portal', brandX, y + 18);

    // Right: Document Title & Reference Block
    doc
      .fillColor(COLORS.headerBand)
      .font(FONT.bold)
      .fontSize(14)
      .text('TAX ASSESSMENT SLIP', LEFT, headerTop, { align: 'right' });

    doc
      .fillColor(COLORS.muted)
      .font(FONT.bold)
      .fontSize(9)
      .text(`SLIP NO: ${data.slipNumber}`, LEFT, headerTop + 18, { align: 'right' });

    doc
      .fillColor(COLORS.faint)
      .font(FONT.regular)
      .fontSize(8)
      .text(`Issued: ${formatDate(data.generatedAt)}`, LEFT, headerTop + 30, { align: 'right' });

    y = headerTop + 48;

    // ── 3. Status Banner ─────────────────────────────────────
    const isPaid = data.paymentStatus === 'completed' || data.isLocked;
    const isFinalized = data.isFinalized;

    let bannerBg = COLORS.panel;
    let bannerBorder = COLORS.hairline;
    let bannerColor = COLORS.muted;
    let bannerText = 'PROVISIONAL TAX ASSESSMENT (DRAFT)';
    let bannerSub = 'Draft calculation subject to review prior to finalization and remittance.';

    if (isPaid) {
      bannerBg = COLORS.successBg;
      bannerBorder = COLORS.successBorder;
      bannerColor = COLORS.success;
      bannerText = 'OFFICIAL TAX SLIP — PAID & REMITTED';
      bannerSub = 'Tax assessment has been fully paid and recorded for statutory FIRS compliance.';
    } else if (isFinalized) {
      bannerBg = COLORS.blueBg;
      bannerBorder = COLORS.blueBorder;
      bannerColor = COLORS.blue;
      bannerText = 'FINALIZED ASSESSMENT — AWAITING PAYMENT';
      bannerSub = 'Monthly assessment confirmed and locked. Remit payable tax to maintain FIRS compliance.';
    }

    doc
      .roundedRect(LEFT, y, PAGE_WIDTH, 32, 5)
      .fillAndStroke(bannerBg, bannerBorder);

    doc
      .fillColor(bannerColor)
      .font(FONT.bold)
      .fontSize(9)
      .text(bannerText, LEFT + 12, y + 7);

    doc
      .fillColor(COLORS.body)
      .font(FONT.regular)
      .fontSize(7.5)
      .text(bannerSub, LEFT + 12, y + 19);

    y += 42;

    // ── 4. Metadata Two-Column Card ──────────────────────────
    const colWidth = (PAGE_WIDTH - 15) / 2;
    const cardHeight = 88;

    // Left Column: Business / Taxpayer Details
    doc
      .roundedRect(LEFT, y, colWidth, cardHeight, 5)
      .fillAndStroke(COLORS.panel, COLORS.hairline);

    doc
      .fillColor(COLORS.muted)
      .font(FONT.bold)
      .fontSize(7.5)
      .text('TAXPAYER / BUSINESS DETAILS', LEFT + 10, y + 8);

    doc
      .fillColor(COLORS.ink)
      .font(FONT.bold)
      .fontSize(10)
      .text(data.business.businessName, LEFT + 10, y + 21, { width: colWidth - 20, lineBreak: false });

    doc
      .fillColor(COLORS.body)
      .font(FONT.regular)
      .fontSize(8);

    const leftDetails = [
      `Merchant ID: ${data.business.merchantId}`,
      `Tax ID (TIN): ${data.business.taxId || 'Not registered / In Progress'}`,
      `Owner / Contact: ${data.business.ownerName}`,
      data.business.address ? `Address: ${data.business.address.slice(0, 38)}` : `Email: ${data.business.email || 'N/A'}`,
    ];

    let dy = y + 36;
    leftDetails.forEach((line) => {
      doc.text(line, LEFT + 10, dy, { width: colWidth - 20, lineBreak: false });
      dy += 11;
    });

    // Right Column: Assessment Period & Authority Details
    const rightX = LEFT + colWidth + 15;
    doc
      .roundedRect(rightX, y, colWidth, cardHeight, 5)
      .fillAndStroke(COLORS.panel, COLORS.hairline);

    doc
      .fillColor(COLORS.muted)
      .font(FONT.bold)
      .fontSize(7.5)
      .text('ASSESSMENT SPECIFICATIONS', rightX + 10, y + 8);

    doc
      .fillColor(COLORS.accentDark)
      .font(FONT.bold)
      .fontSize(11)
      .text(formatMonthYear(data.taxMonth).toUpperCase(), rightX + 10, y + 21);

    const rightDetails = [
      `Tax Jurisdiction: Nigeria (Federal Inland Revenue Service)`,
      `Statutory Formula: Tax = 7.5% × (Total Sales − Expenses)`,
      `Assessment Status: ${isPaid ? 'Paid & Compliant' : isFinalized ? 'Finalized' : 'Draft Assessment'}`,
      `Due Date: 21st of ${new Date(new Date(data.taxMonth).setMonth(new Date(data.taxMonth).getMonth() + 1)).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' })}`,
    ];

    dy = y + 36;
    rightDetails.forEach((line) => {
      doc.fillColor(COLORS.body).font(FONT.regular).fontSize(8).text(line, rightX + 10, dy, { width: colWidth - 20, lineBreak: false });
      dy += 11;
    });

    y += cardHeight + 14;

    // ── 5. Assessment Computation Table ──────────────────────
    doc
      .fillColor(COLORS.ink)
      .font(FONT.bold)
      .fontSize(10)
      .text('Monthly Tax Assessment Breakdown', LEFT, y);
    y += 15;

    // Table Header Band
    const tableHeaderY = y;
    doc
      .roundedRect(LEFT, tableHeaderY, PAGE_WIDTH, 20, 3)
      .fill(COLORS.headerBand);

    doc.fillColor(COLORS.onAccent).font(FONT.bold).fontSize(8);
    doc.text('ASSESSMENT COMPONENT', LEFT + 10, tableHeaderY + 6);
    doc.text('CALCULATION BASIS', LEFT + 260, tableHeaderY + 6);
    doc.text('AMOUNT (NGN)', RIGHT - 110, tableHeaderY + 6, { width: 100, align: 'right' });

    y = tableHeaderY + 23;

    // Row definitions
    const rows = [
      {
        title: 'Total Gross Sales (Revenue)',
        subtitle: 'Confirmed sales, POS collections, and bank inflows',
        basis: 'Gross Turnover (A)',
        amount: formatMoney(data.assessment.totalSales),
        isNegative: false,
      },
      {
        title: 'Allowable Business Expenses',
        subtitle: 'Deductible operating expenses logged for this month',
        basis: 'Deductible Outflows (B)',
        amount: `- ${formatMoney(data.assessment.totalExpenses)}`,
        isNegative: true,
      },
      {
        title: 'Gross Profit (Taxable Surplus)',
        subtitle: 'Net assessment base subject to statutory SME tax',
        basis: 'Taxable Income (A − B)',
        amount: formatMoney(data.assessment.grossProfit),
        isBold: true,
      },
      {
        title: 'Statutory SME Tax Rate',
        subtitle: 'Federal Inland Revenue Service prescribed SME rate',
        basis: 'Fixed Statutory Rate',
        amount: `${data.assessment.taxRate.toFixed(2)}%`,
      },
    ];

    rows.forEach((row, i) => {
      const rowY = y;
      const rowHeight = 28;

      // Subtle zebra striping
      if (i % 2 === 1) {
        doc.rect(LEFT, rowY, PAGE_WIDTH, rowHeight).fill('#fbfcfd');
      }

      // Title & Subtitle
      doc
        .fillColor(row.isBold ? COLORS.ink : COLORS.body)
        .font(row.isBold ? FONT.bold : FONT.regular)
        .fontSize(8.5)
        .text(row.title, LEFT + 10, rowY + 5);

      doc
        .fillColor(COLORS.faint)
        .font(FONT.regular)
        .fontSize(7)
        .text(row.subtitle, LEFT + 10, rowY + 16);

      // Basis
      doc
        .fillColor(COLORS.muted)
        .font(FONT.regular)
        .fontSize(8)
        .text(row.basis, LEFT + 260, rowY + 10);

      // Amount
      doc
        .fillColor(row.isBold ? COLORS.ink : COLORS.body)
        .font(row.isBold ? FONT.bold : FONT.regular)
        .fontSize(8.5)
        .text(row.amount, RIGHT - 110, rowY + 10, { width: 100, align: 'right' });

      // Hairline divider below
      doc
        .moveTo(LEFT, rowY + rowHeight)
        .lineTo(RIGHT, rowY + rowHeight)
        .strokeColor(COLORS.hairline)
        .lineWidth(0.5)
        .stroke();

      y += rowHeight;
    });

    // ── 6. Payable Tax Summary Bar ───────────────────────────
    y += 4;
    const summaryHeight = 40;
    doc
      .roundedRect(LEFT, y, PAGE_WIDTH, summaryHeight, 6)
      .fillAndStroke('#f5f3ff', COLORS.accent);

    doc
      .fillColor(COLORS.accentDark)
      .font(FONT.bold)
      .fontSize(11)
      .text('TOTAL TAX PAYABLE / ASSESSED', LEFT + 14, y + 10);

    doc
      .fillColor(COLORS.muted)
      .font(FONT.regular)
      .fontSize(7.5)
      .text('Statutory obligation due to Federal Inland Revenue Service (FIRS)', LEFT + 14, y + 23);

    doc
      .fillColor(COLORS.accentDark)
      .font(FONT.bold)
      .fontSize(15)
      .text(formatMoney(data.assessment.taxPayable), RIGHT - 180, y + 12, { width: 170, align: 'right' });

    y += summaryHeight + 14;

    // ── 7. Payment & Remittance Details (if paid or pending) ──
    if (isPaid && data.payment) {
      const boxHeight = 50;
      doc
        .roundedRect(LEFT, y, PAGE_WIDTH, boxHeight, 5)
        .fillAndStroke(COLORS.successBg, COLORS.successBorder);

      doc
        .fillColor(COLORS.success)
        .font(FONT.bold)
        .fontSize(8.5)
        .text('TAX PAYMENT & FIRS REMITTANCE CONFIRMATION', LEFT + 12, y + 7);

      doc
        .fillColor(COLORS.body)
        .font(FONT.regular)
        .fontSize(7.5);

      doc.text(`Payment Ref: ${data.payment.paymentReference}`, LEFT + 12, y + 21, { width: 175 });
      doc.text(`Date Paid: ${data.payment.paymentDate ? formatDate(data.payment.paymentDate) : 'Confirmed'}`, LEFT + 195, y + 21, { width: 105 });
      doc.text(`Amount Paid: ${formatMoney(data.payment.amountPaid || data.assessment.taxPayable)}`, LEFT + 305, y + 21, { width: 115 });
      doc.text(`Status: COMPLETED`, LEFT + 425, y + 21, { width: 75 });

      doc
        .fillColor(COLORS.muted)
        .font(FONT.regular)
        .fontSize(7)
        .text('Statutory electronic remittance processed via PayMyTax automated gateway. Record certified for FIRS compliance.', LEFT + 12, y + 35);

      y += boxHeight + 10;
    } else {
      doc
        .roundedRect(LEFT, y, PAGE_WIDTH, 38, 5)
        .fillAndStroke(COLORS.panel, COLORS.panelBorder);

      doc
        .fillColor(COLORS.ink)
        .font(FONT.bold)
        .fontSize(8)
        .text('HOW TO REMIT YOUR MONTHLY TAX', LEFT + 12, y + 7);

      doc
        .fillColor(COLORS.body)
        .font(FONT.regular)
        .fontSize(7.5)
        .text(
          'Log in to your PayMyTax SME dashboard at any time and click "Pay Now" on this assessment report. Instant card, transfer, and virtual account payments are supported with automated instant receipt generation.',
          LEFT + 12,
          y + 19,
          { width: PAGE_WIDTH - 24 }
        );

      y += 46;
    }

    // ── 8. Statutory Disclaimer & Verification Seal ──────────
    drawTaxSlipVerificationSeal({
      doc,
      left: LEFT,
      right: RIGHT,
      pageWidth: PAGE_WIDTH,
      y,
      isPaid,
      slipNumber: data.slipNumber,
      generatedAt: data.generatedAt,
      colors: {
        hairline: COLORS.hairline,
        muted: COLORS.muted,
        faint: COLORS.faint,
        success: COLORS.success,
      },
    });

    // ── 9. Footer Band ───────────────────────────────────────
    doc
      .fillColor(COLORS.faint)
      .font(FONT.regular)
      .fontSize(7)
      .text(
        `PayMyTax by WallX • SME Tax Remittance System • Authority: ${config.tax.taxAuthority} • Generated: ${new Date().toLocaleDateString('en-NG')} • Page 1 of 1`,
        LEFT,
        805,
        { align: 'center', width: PAGE_WIDTH }
      );

    doc.end();
  });
}
