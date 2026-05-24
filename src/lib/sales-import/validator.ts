/**
 * Sales Import — row-level validator & normalizer.
 *
 * Each uploaded row has to survive three kinds of real-world mess before
 * we let it near the DB:
 *   1. Excel date weirdness — serial numbers, "15/04/2026" UK style, ISO strings
 *   2. Amount weirdness — "₦150,000", "150,000.00", "NGN 150k" (reject)
 *   3. Source enum weirdness — "Bank Transfer", "BANK_TRANSFER", "pos "
 *
 * We return a discriminated result per row so the caller can build a
 * preview with clear field-level errors.
 */
import { SALES_IMPORT_SOURCES } from './template';

export type SourceEnum = (typeof SALES_IMPORT_SOURCES)[number];

export interface RawRow {
  // index in the original file (1-based, excluding header) — for error messages
  rowNumber: number;
  transaction_date: unknown;
  amount: unknown;
  source: unknown;
  customer_name?: unknown;
  description?: unknown;
  reference_id?: unknown;
}

export interface ParsedRow {
  rowNumber: number;
  transactionDate: Date;
  amount: number;
  source: SourceEnum;
  customerName?: string;
  description?: string;
  referenceId?: string;
}

export interface RowError {
  field: string;
  message: string;
}

export type RowValidationResult =
  | { ok: true; row: ParsedRow }
  | { ok: false; rowNumber: number; errors: RowError[] };

// ─── Header fuzzy matching ──────────────────────────────────

/**
 * Normalize a header string for comparison:
 *   "Transaction Date" → "transactiondate"
 *   "Amount (NGN)"     → "amountngn"
 *   "Txn Date"         → "txndate"
 */
function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES: Record<keyof RawRow, string[]> = {
  rowNumber: [],
  transaction_date: ['transactiondate', 'txndate', 'date', 'salesdate'],
  amount: ['amount', 'amountngn', 'amountn', 'total', 'value', 'price'],
  source: ['source', 'channel', 'paymentmethod', 'method'],
  customer_name: ['customername', 'customer', 'client', 'buyer', 'name'],
  description: ['description', 'details', 'item', 'narration', 'note', 'notes'],
  reference_id: ['referenceid', 'reference', 'ref', 'refno', 'refid', 'txref', 'transactionref'],
};

export interface HeaderMap {
  // column index (0-based) in the parsed file for each logical field.
  // -1 means not found.
  transaction_date: number;
  amount: number;
  source: number;
  customer_name: number;
  description: number;
  reference_id: number;
}

export interface HeaderMapResult {
  map: HeaderMap;
  missingRequired: string[];
}

export function buildHeaderMap(rawHeaders: string[]): HeaderMapResult {
  const normalized = rawHeaders.map(normalizeHeader);

  const find = (key: keyof RawRow): number => {
    for (const alias of HEADER_ALIASES[key]) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const map: HeaderMap = {
    transaction_date: find('transaction_date'),
    amount: find('amount'),
    source: find('source'),
    customer_name: find('customer_name'),
    description: find('description'),
    reference_id: find('reference_id'),
  };

  const missingRequired: string[] = [];
  if (map.transaction_date === -1) missingRequired.push('transaction_date');
  if (map.amount === -1) missingRequired.push('amount');
  if (map.source === -1) missingRequired.push('source');

  return { map, missingRequired };
}

// ─── Date normalization ─────────────────────────────────────

/**
 * Excel stores dates as floats (days since 1899-12-30). exceljs usually
 * hands us a Date for typed cells but CSVs are strings, and sometimes
 * people paste "45778" as raw text. Handle both.
 */
function parseExcelSerial(n: number): Date | null {
  // Excel's epoch is 1899-12-30 (accounting for the 1900 leap-year bug).
  // Serial 1 = 1900-01-01. Reasonable range: 1 .. 80000 (~year 2119).
  if (!Number.isFinite(n) || n < 1 || n > 80000) return null;
  const ms = (n - 25569) * 86400 * 1000; // 25569 = days between 1899-12-30 and 1970-01-01
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateString(s: string): Date | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  // ISO: 2026-04-15 or 2026-04-15T...
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso && iso[1] && iso[2] && iso[3]) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD-MM-YYYY (UK/Nigerian convention)
  const dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(trimmed);
  if (dmy && dmy[1] && dmy[2] && dmy[3]) {
    const day = +dmy[1];
    const month = +dmy[2];
    const year = +dmy[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Pure-numeric string that looks like an Excel serial ("45778")
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseExcelSerial(Number(trimmed));
  }

  // Last resort: let JS try
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function normalizeDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    return parseExcelSerial(value);
  }
  if (typeof value === 'string') {
    return parseDateString(value);
  }
  return null;
}

// ─── Amount normalization ───────────────────────────────────

export function normalizeAmount(value: unknown): { ok: true; amount: number } | { ok: false; message: string } {
  if (value == null || value === '') {
    return { ok: false, message: 'amount is required' };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, message: 'amount is not a valid number' };
    if (value <= 0) return { ok: false, message: 'amount must be greater than 0' };
    return { ok: true, amount: Math.round(value * 100) / 100 };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: 'amount is not a valid number' };
  }

  let s = value.trim();
  if (!s) return { ok: false, message: 'amount is required' };

  // Reject shorthand (150k, 1.5m) — force explicit numbers
  if (/[km]\s*$/i.test(s)) {
    return { ok: false, message: 'use a full number (e.g. 150000), not shorthand like 150k' };
  }

  // Strip currency symbols + whitespace + thousands separators
  s = s
    .replace(/₦/g, '')
    .replace(/NGN/gi, '')
    .replace(/\s+/g, '')
    .replace(/,/g, '');

  if (!s) return { ok: false, message: 'amount is required' };

  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, message: 'amount is not a valid number' };
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, message: 'amount is not a valid number' };
  if (n <= 0) return { ok: false, message: 'amount must be greater than 0' };

  return { ok: true, amount: Math.round(n * 100) / 100 };
}

// ─── Source normalization ───────────────────────────────────

/**
 * Normalize a source cell:
 *   "Bank Transfer"   → "bank_transfer"
 *   "BANK_TRANSFER"   → "bank_transfer"
 *   "bank-transfer "  → "bank_transfer"
 *   "Online"          → "online_store" (alias)
 *   "Card"            → null (unknown)
 */
const SOURCE_ALIASES: Record<string, SourceEnum> = {
  banktransfer: 'bank_transfer',
  bank: 'bank_transfer',
  transfer: 'bank_transfer',
  paycode: 'paycode',
  pos: 'pos',
  posterminal: 'pos',
  onlinestore: 'online_store',
  online: 'online_store',
  ecommerce: 'online_store',
  web: 'online_store',
  manual: 'manual',
  cash: 'manual',
  walkin: 'manual',
};

export function normalizeSource(value: unknown): SourceEnum | null {
  if (value == null) return null;
  const raw = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!raw) return null;

  // Exact enum match first
  if ((SALES_IMPORT_SOURCES as readonly string[]).includes(raw)) {
    return raw as SourceEnum;
  }
  // collapsed match (bank_transfer → banktransfer)
  const collapsedEnum = SALES_IMPORT_SOURCES.find(
    (s) => s.replace(/_/g, '') === raw
  );
  if (collapsedEnum) return collapsedEnum;

  return SOURCE_ALIASES[raw] ?? null;
}

// ─── Per-row validation ─────────────────────────────────────

function trimString(v: unknown, max: number): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

export function validateRow(raw: RawRow): RowValidationResult {
  const errors: RowError[] = [];

  const date = normalizeDate(raw.transaction_date);
  if (!date) {
    errors.push({
      field: 'transaction_date',
      message: 'missing or unparseable — use YYYY-MM-DD or DD/MM/YYYY',
    });
  }

  const amountResult = normalizeAmount(raw.amount);
  if (amountResult.ok === false) {
    errors.push({ field: 'amount', message: amountResult.message });
  }

  const source = normalizeSource(raw.source);
  if (!source) {
    errors.push({
      field: 'source',
      message: `must be one of ${SALES_IMPORT_SOURCES.join(', ')}`,
    });
  }

  const customerName = trimString(raw.customer_name, 200);
  const description = trimString(raw.description, 500);
  const referenceId = trimString(raw.reference_id, 200);

  if (errors.length > 0) {
    return { ok: false, rowNumber: raw.rowNumber, errors };
  }

  return {
    ok: true,
    row: {
      rowNumber: raw.rowNumber,
      transactionDate: date!,
      amount: amountResult.ok ? amountResult.amount : 0,
      source: source!,
      customerName,
      description,
      referenceId,
    },
  };
}

/**
 * Row is "effectively empty" if every cell is null/undefined/empty string.
 * Users paste data and leave blank rows behind — we silently skip them
 * rather than flagging them as invalid.
 */
export function isRowEmpty(raw: RawRow): boolean {
  const vals = [
    raw.transaction_date,
    raw.amount,
    raw.source,
    raw.customer_name,
    raw.description,
    raw.reference_id,
  ];
  return vals.every((v) => v == null || String(v).trim() === '');
}
