import PDFDocument from 'pdfkit';
import { UnifiedLedgerRow, UnifiedLedgerResponse } from '@/services/ledger.service';
import { fetchLogoForPdf } from '@/lib/pdf-utils';

export interface StatementPdfOptions {
  business: {
    businessName: string;
    merchantId: string;
    ownerName: string;
    taxId: string | null;
    address?: string | null;
    logoUrl?: string | null;
    virtualAccountNumber?: string | null;
    virtualAccountBank?: string | null;
  };
  scope: 'dva_bank' | 'all_income';
  periodLabel: string;
  summary: UnifiedLedgerResponse['summary'];
  rows: UnifiedLedgerRow[];
  statementRef: string;
}

function formatNairaText(amount: number): string {
  return `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateShort(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export async function buildLedgerStatementPdf(options: StatementPdfOptions): Promise<Buffer> {
  const { business, scope, periodLabel, summary, rows, statementRef } = options;

  const logoBuffer = business.logoUrl ? await fetchLogoForPdf(business.logoUrl) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const right = 555;
    const contentWidth = right - left; // 515

    // ── 1. Top Header ─────────────────────────────────────────
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left, 35, { fit: [42, 42] });
      } catch {
        // Fallback gracefully
      }
    }

    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .fillColor('#0F172A')
      .text('PAYMYTAX', left + (logoBuffer ? 50 : 0), 38);

    doc
      .fontSize(8)
      .font('Helvetica-Bold')
      .fillColor('#4F46E5')
      .text(scope === 'dva_bank' ? 'OFFICIAL DVA BANK ACCOUNT STATEMENT' : 'COMPREHENSIVE BUSINESS SALES STATEMENT', left + (logoBuffer ? 50 : 0), 56);

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#64748B')
      .text(`Statement Ref: ${statementRef}`, left, 38, { align: 'right', width: contentWidth });

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#64748B')
      .text(`Generated: ${new Date().toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, left, 50, { align: 'right', width: contentWidth });

    // Divider
    doc.moveTo(left, 82).lineTo(right, 82).strokeColor('#E2E8F0').lineWidth(1).stroke();

    // ── 2. Business & Account Metadata Block ───────────────────
    const metaY = 92;

    // Left Column: Business Info
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155').text('ACCOUNT HOLDER DETAILS', left, metaY);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#0F172A').text(business.businessName, left, metaY + 12);
    doc.fontSize(8).font('Helvetica').fillColor('#475569');
    doc.text(`Owner: ${business.ownerName}`, left, metaY + 26);
    if (business.taxId) doc.text(`Tax ID / TIN: ${business.taxId}`, left, metaY + 37);
    if (business.address) doc.text(`Address: ${business.address}`, left, metaY + 48);

    // Right Column: Virtual Bank & Statement Info
    const rightColX = 330;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155').text('ACCOUNT & STATEMENT INFO', rightColX, metaY);
    doc.fontSize(8).font('Helvetica').fillColor('#475569');
    if (business.virtualAccountNumber) {
      doc.text(`Virtual NUBAN: ${business.virtualAccountNumber}`, rightColX, metaY + 12);
      doc.text(`Bank Name: ${business.virtualAccountBank || 'Wema Bank PLC'}`, rightColX, metaY + 23);
    }
    doc.text(`Merchant ID: ${business.merchantId}`, rightColX, metaY + (business.virtualAccountNumber ? 34 : 12));
    doc.text(`Statement Period: ${periodLabel}`, rightColX, metaY + (business.virtualAccountNumber ? 45 : 23));
    doc.text(`Currency: Nigerian Naira (NGN)`, rightColX, metaY + (business.virtualAccountNumber ? 56 : 34));

    // ── 3. KPI Financial Summary Strip ─────────────────────────
    const cardY = 165;
    const cardW = (contentWidth - 18) / 4;
    const cardH = 46;

    const cards = [
      { label: 'OPENING BALANCE', value: formatNairaText(summary.openingBalance), bg: '#F8FAFC', border: '#E2E8F0', text: '#334155' },
      { label: 'TOTAL INFLOWS (+)', value: `+${formatNairaText(summary.totalCredits)}`, bg: '#ECFDF5', border: '#A7F3D0', text: '#059669' },
      { label: 'TOTAL OUTFLOWS (-)', value: `-${formatNairaText(summary.totalDebits)}`, bg: '#FEF2F2', border: '#FECACA', text: '#DC2626' },
      { label: 'CLOSING BALANCE', value: formatNairaText(summary.closingBalance), bg: '#0F172A', border: '#0F172A', text: '#34D399', isDark: true },
    ];

    cards.forEach((c, i) => {
      const cx = left + i * (cardW + 6);
      doc.roundedRect(cx, cardY, cardW, cardH, 4).fillAndStroke(c.bg, c.border);
      doc
        .fontSize(6.5)
        .font('Helvetica-Bold')
        .fillColor(c.isDark ? '#94A3B8' : '#64748B')
        .text(c.label, cx + 6, cardY + 7, { width: cardW - 12 });
      doc
        .fontSize(8.5)
        .font('Helvetica-Bold')
        .fillColor(c.text)
        .text(c.value, cx + 6, cardY + 22, { width: cardW - 12 });
    });

    // ── 4. Transactions Table ──────────────────────────────────
    let tableY = 224;

    const colX = {
      date: left + 4,
      desc: left + 62,
      ref: left + 225,
      type: left + 325,
      inflow: left + 375,
      outflow: left + 435,
      balance: left + 495,
    };

    function renderTableHeader(y: number) {
      doc.rect(left, y, contentWidth, 18).fill('#F1F5F9');
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#334155');
      doc.text('DATE', colX.date, y + 5);
      doc.text('DESCRIPTION / COUNTERPARTY', colX.desc, y + 5);
      doc.text('REFERENCE', colX.ref, y + 5);
      doc.text('CHANNEL', colX.type, y + 5);
      doc.text('INFLOW (NGN)', colX.inflow, y + 5, { width: 55, align: 'right' });
      doc.text('OUTFLOW (NGN)', colX.outflow, y + 5, { width: 55, align: 'right' });
      doc.text('BALANCE (NGN)', colX.balance, y + 5, { width: 55, align: 'right' });
    }

    renderTableHeader(tableY);
    tableY += 20;

    if (rows.length === 0) {
      doc.fontSize(9).font('Helvetica').fillColor('#64748B').text('No recorded transactions found in the selected period.', left, tableY + 20, { align: 'center', width: contentWidth });
    } else {
      rows.forEach((r, index) => {
        // Page overflow check
        if (tableY > 740) {
          doc.addPage();
          tableY = 40;
          renderTableHeader(tableY);
          tableY += 20;
        }

        const isEven = index % 2 === 0;
        if (isEven) {
          doc.rect(left, tableY - 2, contentWidth, 20).fill('#FAFAFA');
        }

        doc.fontSize(7).font('Helvetica').fillColor('#334155');
        doc.text(formatDateShort(r.date), colX.date, tableY + 2);

        // Description + Counterparty combined cleanly
        const narration = r.counterparty && r.counterparty !== 'Customer'
          ? `${r.description} (${r.counterparty})`
          : r.description;
        doc.text(narration, colX.desc, tableY + 2, { width: 155, ellipsis: true });

        doc.fontSize(6.5).font('Helvetica').fillColor('#64748B').text(r.reference, colX.ref, tableY + 2, { width: 95, ellipsis: true });

        doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#475569').text(r.sourceType.toUpperCase().replace('_', ' '), colX.type, tableY + 2);

        if (r.entryType === 'credit') {
          doc.fontSize(7).font('Helvetica-Bold').fillColor('#059669').text(`+${r.amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, colX.inflow, tableY + 2, { width: 55, align: 'right' });
          doc.fontSize(7).font('Helvetica').fillColor('#94A3B8').text('-', colX.outflow, tableY + 2, { width: 55, align: 'right' });
        } else {
          doc.fontSize(7).font('Helvetica').fillColor('#94A3B8').text('-', colX.inflow, tableY + 2, { width: 55, align: 'right' });
          doc.fontSize(7).font('Helvetica-Bold').fillColor('#DC2626').text(`-${r.amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, colX.outflow, tableY + 2, { width: 55, align: 'right' });
        }

        doc.fontSize(7).font('Helvetica-Bold').fillColor('#0F172A').text(r.runningBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 }), colX.balance, tableY + 2, { width: 55, align: 'right' });

        tableY += 20;
      });
    }

    // ── 5. Official Certification Seal & Footer on All Pages ──
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);

      // Bottom Divider
      doc.moveTo(left, 785).lineTo(right, 785).strokeColor('#E2E8F0').lineWidth(0.8).stroke();

      doc
        .fontSize(6.5)
        .font('Helvetica-Bold')
        .fillColor('#4F46E5')
        .text('CERTIFIED SME FINANCIAL STATEMENT · PAYMYTAX COMPLIANCE PLATFORM', left, 792);

      doc
        .fontSize(6.5)
        .font('Helvetica')
        .fillColor('#94A3B8')
        .text('Compliant with Nigerian FIRS regulations · Valid electronic document', left, 802);

      doc
        .fontSize(7)
        .font('Helvetica')
        .fillColor('#64748B')
        .text(`Page ${i + 1} of ${totalPages}`, left, 792, { align: 'right', width: contentWidth });
    }

    doc.end();
  });
}
