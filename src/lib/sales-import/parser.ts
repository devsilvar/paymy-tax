/**
 * Sales Import — parse uploaded buffer into raw row objects.
 *
 * Supports .xlsx (via exceljs) and .csv (via a minimal RFC4180-ish parser).
 * We return RawRow[] + the raw header row so the caller can fuzzy-match
 * headers and produce clear error messages when they don't match.
 *
 * We deliberately DO NOT validate per-row here — that's the validator's
 * job. This file only does I/O + structural parsing.
 */
import ExcelJS from 'exceljs';
import { AppError } from '@/middleware/errorHandler';
import {
  RawRow,
  HeaderMap,
  buildHeaderMap,
} from './validator';
import { SALES_IMPORT_ROW_CAP } from './template';

export interface ParseResult {
  headers: string[];
  map: HeaderMap;
  missingRequired: string[];
  // Rows WITH the row number already attached. Empty rows filtered out.
  rows: RawRow[];
  totalDataRows: number; // including empty ones, for debugging
}

// ─── CSV parser (minimal RFC4180) ───────────────────────────
/**
 * Splits a CSV into rows of string cells. Handles:
 *   - quoted fields ("a,b")
 *   - escaped quotes inside quoted fields ("" → ")
 *   - \r\n and \n line endings
 * Does NOT handle: stream parsing (we have the whole buffer), UTF-16 BOM
 * on EVERY line (we strip once at the start).
 */
function parseCsv(text: string): string[][] {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // swallow CR — handled with LF below
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }

  // flush final cell/row if no trailing newline
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function isArrayOfEmpty(arr: string[]): boolean {
  return arr.every((c) => c == null || String(c).trim() === '');
}

// ─── Extraction helpers ─────────────────────────────────────

function extractRawRow(
  map: HeaderMap,
  cells: unknown[],
  rowNumber: number
): RawRow {
  const at = (idx: number): unknown => (idx >= 0 && idx < cells.length ? cells[idx] : undefined);
  return {
    rowNumber,
    transaction_date: at(map.transaction_date),
    amount: at(map.amount),
    source: at(map.source),
    customer_name: at(map.customer_name),
    description: at(map.description),
    reference_id: at(map.reference_id),
  };
}

// ─── Cell value normalization ───────────────────────────────

/**
 * exceljs hands us rich objects for formulas, hyperlinks, etc. Flatten to
 * primitive: string | number | Date | null. Anything else becomes string.
 */
function flattenCellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;

  // Rich objects
  if (typeof v === 'object') {
    // Formula cell: { formula: '=...', result: X }
    if ('result' in v && v.result != null) {
      return flattenCellValue(v.result as ExcelJS.CellValue);
    }
    // Hyperlink cell: { text: '...', hyperlink: '...' }
    if ('text' in v && typeof (v as any).text === 'string') {
      return (v as any).text;
    }
    // Rich text: { richText: [{ text: '...' }, ...] }
    if ('richText' in v && Array.isArray((v as any).richText)) {
      return (v as any).richText.map((r: any) => r.text ?? '').join('');
    }
    // Error cell
    if ('error' in v) return null;
  }

  return String(v);
}

// ─── Main entry ─────────────────────────────────────────────

export async function parseSalesImportBuffer(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<ParseResult> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const isCsv =
    ext === 'csv' ||
    mimeType === 'text/csv' ||
    mimeType === 'application/csv';

  if (isCsv) {
    return parseCsvBuffer(buffer);
  }
  // Treat everything else as xlsx and let exceljs error if it isn't
  return parseXlsxBuffer(buffer);
}

async function parseXlsxBuffer(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as any);
  } catch (err: any) {
    throw new AppError(
      400,
      'Could not read the Excel file — it may be corrupt or not a real .xlsx',
      'IMPORT_UNREADABLE_FILE'
    );
  }

  // Always read the first sheet — even if the user renamed it.
  const sheet = wb.worksheets[0];
  if (!sheet) {
    throw new AppError(
      400,
      'No worksheets found in the file',
      'IMPORT_EMPTY_FILE'
    );
  }

  // Extract header row (row 1)
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  // columnCount can be misleading on sparse sheets; iterate cells
  const columnCount = Math.max(headerRow.cellCount, sheet.columnCount);
  for (let c = 1; c <= columnCount; c++) {
    const v = flattenCellValue(headerRow.getCell(c).value);
    headers.push(v == null ? '' : String(v));
  }

  const { map, missingRequired } = buildHeaderMap(headers);

  const rows: RawRow[] = [];
  let totalDataRows = 0;

  // Iterate data rows (starting from 2)
  const lastRow = sheet.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    // Build flat cell array
    const cells: unknown[] = [];
    for (let c = 1; c <= columnCount; c++) {
      cells.push(flattenCellValue(row.getCell(c).value));
    }
    // Skip fully-empty rows silently
    if (cells.every((v) => v == null || String(v).trim() === '')) continue;
    totalDataRows++;
    rows.push(extractRawRow(map, cells, r - 1)); // rowNumber is 1-based excl. header
  }

  return { headers, map, missingRequired, rows, totalDataRows };
}

function parseCsvBuffer(buffer: Buffer): ParseResult {
  const text = buffer.toString('utf-8');
  const parsed = parseCsv(text).filter((r) => !isArrayOfEmpty(r));

  if (parsed.length === 0) {
    return {
      headers: [],
      map: {
        transaction_date: -1,
        amount: -1,
        source: -1,
        customer_name: -1,
        description: -1,
        reference_id: -1,
      },
      missingRequired: ['transaction_date', 'amount', 'source'],
      rows: [],
      totalDataRows: 0,
    };
  }

  const headers = (parsed[0] ?? []).map((h) => String(h ?? ''));
  const { map, missingRequired } = buildHeaderMap(headers);

  const rows: RawRow[] = [];
  let totalDataRows = 0;
  for (let i = 1; i < parsed.length; i++) {
    const cells = parsed[i] ?? [];
    totalDataRows++;
    rows.push(extractRawRow(map, cells as unknown[], i));
  }

  return { headers, map, missingRequired, rows, totalDataRows };
}

export function assertRowCap(count: number): void {
  if (count > SALES_IMPORT_ROW_CAP) {
    throw new AppError(
      400,
      `This upload has ${count} rows — the maximum is ${SALES_IMPORT_ROW_CAP}. Split your spreadsheet into smaller files.`,
      'IMPORT_ROW_CAP_EXCEEDED',
      { cap: SALES_IMPORT_ROW_CAP, received: count }
    );
  }
}
