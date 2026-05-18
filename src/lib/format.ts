// Lightweight formatters shared across services. Backend-only — frontend
// has its own helpers in pages. Keep these dependency-free and synchronous.

import type { Prisma } from '@prisma/client';

type Numeric = number | string | Prisma.Decimal;

function toNumber(n: Numeric): number {
  if (typeof n === 'number') return n;
  if (typeof n === 'string') return Number(n);
  return Number(n.toString());
}

export function formatNaira(amount: Numeric): string {
  return `₦${toNumber(amount).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatTaxMonth(taxMonth: Date): string {
  return taxMonth.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

export function formatDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
