// ─── Design Tokens & Formatters for PDF Receipts & Slips ───────────────────

export const COLORS = {
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

export const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
};

export const LEFT = 50;
export const RIGHT = 545;
export const PAGE_WIDTH = RIGHT - LEFT;
export const RADIUS = 6;

export function formatMoney(amount: number): string {
  return `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(d: Date | string): string {
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  return dateObj.toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(d: Date | string): string {
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  return dateObj.toLocaleDateString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatQty(qty: number): string {
  return Number.isInteger(qty) ? qty.toString() : qty.toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

export function formatMonthYear(d: Date | string): string {
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  return dateObj.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}
