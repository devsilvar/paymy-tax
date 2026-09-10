import { Decimal } from '@prisma/client/runtime/library';

export type Numeric = number | string | Decimal | { toNumber: () => number } | null | undefined;

/**
 * Canonical toNumber converter.
 * Handles Decimal, numbers, numeric strings, null, undefined, or any object with .toNumber().
 * Returns 0 on NaN or nullish input.
 */
export function toNumber(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isNaN(val) ? 0 : val;
  if (typeof val === 'string') {
    const parsed = Number(val);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof (val as { toNumber?: unknown }).toNumber === 'function') {
    const num = (val as { toNumber: () => number }).toNumber();
    return Number.isNaN(num) ? 0 : num;
  }
  const parsed = Number(val);
  return Number.isNaN(parsed) ? 0 : parsed;
}
