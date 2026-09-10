import { FONT } from './receipt-common.pdf';

interface RenderSealOptions {
  doc: PDFKit.PDFDocument;
  left: number;
  right: number;
  pageWidth: number;
  y: number;
  isPaid: boolean;
  slipNumber: string;
  generatedAt: Date;
  colors: {
    hairline: string;
    muted: string;
    faint: string;
    success: string;
  };
}

/**
 * Draws the statutory compliance disclaimer and optional FIRS verification stamp.
 */
export function drawTaxSlipVerificationSeal(options: RenderSealOptions): void {
  const { doc, left, right, pageWidth, isPaid, slipNumber, generatedAt, colors } = options;
  let { y } = options;

  const remainingSpace = 795 - y;
  if (remainingSpace <= 50) return;

  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .strokeColor(colors.hairline)
    .lineWidth(0.5)
    .stroke();
  y += 8;

  if (isPaid) {
    const textWidth = pageWidth - 180;
    doc
      .fillColor(colors.muted)
      .font(FONT.bold)
      .fontSize(7)
      .text('STATUTORY DECLARATION & AUDIT VERIFICATION', left, y);
    y += 10;

    doc
      .fillColor(colors.faint)
      .font(FONT.regular)
      .fontSize(6.5)
      .text(
        `This Monthly Tax Assessment Slip is electronically compiled and certified by PayMyTax by WallX in compliance with the Federal Inland Revenue Service (FIRS) SME Taxation Framework. Computations are based on reconciled business records for the specified month. Tax Formula: Tax Payable = 7.5% × (Total Sales − Allowable Expenses). Valid without physical signature under the Electronic Transactions Act. Verification Ref: ${slipNumber}. Generated on ${generatedAt.toISOString()}.`,
        left,
        y,
        { width: textWidth, align: 'justify', lineGap: 1 }
      );

    // Official Green FIRS Compliance Certification Stamp
    const stampX = right - 165;
    const stampY = y - 6;
    const stampW = 165;
    const stampH = 50;

    doc
      .roundedRect(stampX, stampY, stampW, stampH, 4)
      .lineWidth(1.2)
      .strokeColor(colors.success)
      .stroke();

    doc
      .roundedRect(stampX + 2.5, stampY + 2.5, stampW - 5, stampH - 5, 3)
      .lineWidth(0.5)
      .strokeColor(colors.success)
      .stroke();

    doc
      .fillColor(colors.success)
      .font(FONT.bold)
      .fontSize(7.5)
      .text('★ FIRS COMPLIANCE CERTIFIED ★', stampX, stampY + 6, {
        width: stampW,
        align: 'center',
      });

    doc
      .fillColor(colors.success)
      .font(FONT.bold)
      .fontSize(9.5)
      .text('TAX PAID & REMITTED', stampX, stampY + 16, {
        width: stampW,
        align: 'center',
      });

    doc
      .fillColor(colors.success)
      .font(FONT.regular)
      .fontSize(6)
      .text(`VERIFIED: ${slipNumber}`, stampX, stampY + 28, {
        width: stampW,
        align: 'center',
      });

    doc
      .fillColor(colors.success)
      .font(FONT.regular)
      .fontSize(5.5)
      .text('OFFICIAL ELECTRONIC COMPLIANCE SEAL', stampX, stampY + 37, {
        width: stampW,
        align: 'center',
      });
  } else {
    doc
      .fillColor(colors.muted)
      .font(FONT.bold)
      .fontSize(7)
      .text('STATUTORY DECLARATION & AUDIT VERIFICATION', left, y);
    y += 10;

    doc
      .fillColor(colors.faint)
      .font(FONT.regular)
      .fontSize(6.5)
      .text(
        `This Monthly Tax Assessment Slip is electronically compiled and certified by PayMyTax by WallX in compliance with the Federal Inland Revenue Service (FIRS) SME Taxation Framework. Computations are based on reconciled business records for the specified month. Tax Formula: Tax Payable = 7.5% × (Total Sales − Allowable Expenses). Valid without physical signature under the Electronic Transactions Act. Verification Ref: ${slipNumber}. Generated on ${generatedAt.toISOString()}.`,
        left,
        y,
        { width: pageWidth, align: 'justify', lineGap: 1 }
      );
  }
}
