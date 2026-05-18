/**
 * Sales Import Service — preview + commit orchestration.
 *
 * Flow:
 *   1. download template (static-ish .xlsx)
 *   2. preview(buffer) → parse + validate + check dupes + check locks
 *        → cache result under a token, return summary + per-row status
 *   3. commit(token) → re-check lock, bulk-create with skipDuplicates
 *
 * Why two-step instead of one-step?
 *   - Users need a chance to confirm before we persist 100 rows.
 *   - Invalid rows should block? No — the UI lets the user import only
 *     the valid ones. We preserve their choice via the token cache.
 *   - Race: if a report gets finalized between preview and commit, we
 *     re-check month-lock at commit time and filter silently.
 */
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import {
  parseSalesImportBuffer,
  assertRowCap,
} from '@/lib/sales-import/parser';
import {
  validateRow,
  isRowEmpty,
  ParsedRow,
  RowError,
} from '@/lib/sales-import/validator';
import {
  buildSalesImportTemplate,
  SALES_IMPORT_SOURCES,
} from '@/lib/sales-import/template';
import {
  putImport,
  getImport,
  dropImport,
} from '@/lib/sales-import/cache';

// ─── Ownership helper (private copy — not imported to avoid cycles) ──

async function verifyBusinessOwnership(userId: string, businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }
  return business;
}

// ─── Template download ──────────────────────────────────────

export async function buildTemplate(userId: string, businessId: string): Promise<Buffer> {
  await verifyBusinessOwnership(userId, businessId);
  return buildSalesImportTemplate();
}

// ─── Preview ────────────────────────────────────────────────

export type PreviewRowStatus =
  | 'valid'
  | 'invalid'
  | 'duplicate_in_file'
  | 'duplicate_in_db'
  | 'locked';

export interface PreviewRow {
  rowNumber: number;
  status: PreviewRowStatus;
  // Present when status === 'valid' | 'duplicate_in_file' | 'duplicate_in_db' | 'locked'
  data?: {
    transactionDate: string;
    amount: number;
    source: string;
    customerName?: string;
    description?: string;
    referenceId?: string;
  };
  errors?: RowError[]; // present when status === 'invalid'
}

export interface PreviewSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicateInFile: number;
  duplicateInDb: number;
  locked: number;
}

export interface PreviewResult {
  fileToken: string;
  summary: PreviewSummary;
  rows: PreviewRow[];
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export async function previewImport(
  userId: string,
  businessId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string }
): Promise<PreviewResult> {
  await verifyBusinessOwnership(userId, businessId);

  // 1. Parse the buffer
  const parsed = await parseSalesImportBuffer(file.buffer, file.mimetype, file.originalname);

  if (parsed.missingRequired.length > 0) {
    throw new AppError(
      400,
      `Your spreadsheet is missing required columns: ${parsed.missingRequired.join(', ')}. Download the template to see the required format.`,
      'IMPORT_MISSING_COLUMNS',
      { missing: parsed.missingRequired }
    );
  }

  if (parsed.rows.length === 0) {
    throw new AppError(
      400,
      'No data rows found — check your spreadsheet.',
      'IMPORT_NO_ROWS'
    );
  }

  assertRowCap(parsed.rows.length);

  // 2. Per-row validation
  const validated = parsed.rows
    .filter((r) => !isRowEmpty(r))
    .map((r) => validateRow(r));

  // 3. Flag duplicates inside the file — same (source, referenceId) within upload.
  //    Only meaningful when referenceId is set.
  const seenKeys = new Set<string>();
  const duplicateInFileRowNumbers = new Set<number>();

  const validRows: ParsedRow[] = [];
  const invalidRowsOutput: Array<{ rowNumber: number; errors: RowError[] }> = [];

  for (const result of validated) {
    if (!result.ok) {
      invalidRowsOutput.push({ rowNumber: result.rowNumber, errors: result.errors });
      continue;
    }
    const row = result.row;
    if (row.referenceId) {
      const key = `${row.source}::${row.referenceId}`;
      if (seenKeys.has(key)) {
        duplicateInFileRowNumbers.add(row.rowNumber);
      } else {
        seenKeys.add(key);
      }
    }
    validRows.push(row);
  }

  // 4. Flag duplicates against DB — look up by (source, referenceId) pairs.
  //    Only applies to rows with a referenceId.
  const dbQueryableRows = validRows.filter(
    (r) => r.referenceId && !duplicateInFileRowNumbers.has(r.rowNumber)
  );

  const duplicateInDbKeys = new Set<string>();
  if (dbQueryableRows.length > 0) {
    const existing = await prisma.salesTransaction.findMany({
      where: {
        businessId,
        OR: dbQueryableRows.map((r) => ({
          source: r.source,
          referenceId: r.referenceId!,
        })),
      },
      select: { source: true, referenceId: true },
    });
    for (const e of existing) {
      if (e.referenceId) duplicateInDbKeys.add(`${e.source}::${e.referenceId}`);
    }
  }

  // 5. Flag locked months — batch by distinct month.
  const distinctMonths = new Map<string, Date>();
  for (const r of validRows) {
    const ms = monthStart(r.transactionDate);
    distinctMonths.set(ms.toISOString(), ms);
  }
  const lockedMonthSet = new Set<string>();
  if (distinctMonths.size > 0) {
    const reports = await prisma.monthlyTaxReport.findMany({
      where: {
        businessId,
        taxMonth: { in: Array.from(distinctMonths.values()) },
        OR: [{ isLocked: true }, { isFinalized: true }],
      },
      select: { taxMonth: true },
    });
    for (const rep of reports) {
      lockedMonthSet.add(monthStart(rep.taxMonth).toISOString());
    }
  }

  // 6. Classify each validated row into the PreviewRow shape
  const previewRows: PreviewRow[] = [];

  for (const invalid of invalidRowsOutput) {
    previewRows.push({
      rowNumber: invalid.rowNumber,
      status: 'invalid',
      errors: invalid.errors,
    });
  }

  const duplicateInFileNums: number[] = [];
  const duplicateInDbNums: number[] = [];
  const lockedMonthNums: number[] = [];
  const importableRows: ParsedRow[] = [];

  for (const row of validRows) {
    const data = {
      transactionDate: row.transactionDate.toISOString().slice(0, 10),
      amount: row.amount,
      source: row.source,
      customerName: row.customerName,
      description: row.description,
      referenceId: row.referenceId,
    };

    if (duplicateInFileRowNumbers.has(row.rowNumber)) {
      duplicateInFileNums.push(row.rowNumber);
      previewRows.push({ rowNumber: row.rowNumber, status: 'duplicate_in_file', data });
      continue;
    }

    const key = row.referenceId ? `${row.source}::${row.referenceId}` : null;
    if (key && duplicateInDbKeys.has(key)) {
      duplicateInDbNums.push(row.rowNumber);
      previewRows.push({ rowNumber: row.rowNumber, status: 'duplicate_in_db', data });
      continue;
    }

    const ms = monthStart(row.transactionDate).toISOString();
    if (lockedMonthSet.has(ms)) {
      lockedMonthNums.push(row.rowNumber);
      previewRows.push({ rowNumber: row.rowNumber, status: 'locked', data });
      continue;
    }

    importableRows.push(row);
    previewRows.push({ rowNumber: row.rowNumber, status: 'valid', data });
  }

  // Sort by rowNumber for predictable UI
  previewRows.sort((a, b) => a.rowNumber - b.rowNumber);

  const summary: PreviewSummary = {
    total: validated.length,
    valid: importableRows.length,
    invalid: invalidRowsOutput.length,
    duplicateInFile: duplicateInFileNums.length,
    duplicateInDb: duplicateInDbNums.length,
    locked: lockedMonthNums.length,
  };

  // 7. Cache only the rows that can actually be committed.
  const fileToken = putImport({
    userId,
    businessId,
    filename: file.originalname,
    rows: importableRows,
    invalidRows: invalidRowsOutput,
    duplicateInFile: duplicateInFileNums,
    duplicateInDb: duplicateInDbNums,
    lockedMonth: lockedMonthNums,
  });

  logger.info('Sales import preview built', {
    userId,
    businessId,
    filename: file.originalname,
    summary,
  });

  return { fileToken, summary, rows: previewRows };
}

// ─── Commit ─────────────────────────────────────────────────

export interface CommitResult {
  imported: number;
  skippedRaceDuplicates: number;
  skippedLockedAtCommit: number;
  invalidCount: number;
  duplicateInFileCount: number;
  duplicateInDbCount: number;
  lockedMonthCount: number;
}

export async function commitImport(
  userId: string,
  businessId: string,
  fileToken: string
): Promise<CommitResult> {
  await verifyBusinessOwnership(userId, businessId);

  const cached = getImport(fileToken, userId, businessId);
  if (!cached) {
    throw new AppError(
      410,
      'Your import preview has expired or is invalid. Please re-upload the file.',
      'IMPORT_TOKEN_EXPIRED'
    );
  }

  if (cached.rows.length === 0) {
    // Nothing to commit — still drop the token so subsequent clicks don't loop.
    dropImport(fileToken);
    return {
      imported: 0,
      skippedRaceDuplicates: 0,
      skippedLockedAtCommit: 0,
      invalidCount: cached.invalidRows.length,
      duplicateInFileCount: cached.duplicateInFile.length,
      duplicateInDbCount: cached.duplicateInDb.length,
      lockedMonthCount: cached.lockedMonth.length,
    };
  }

  // Re-check month locks at commit time — a report could have been finalized
  // between preview and commit.
  const distinctMonths = new Map<string, Date>();
  for (const r of cached.rows) {
    const ms = monthStart(r.transactionDate);
    distinctMonths.set(ms.toISOString(), ms);
  }
  const nowLocked = new Set<string>();
  if (distinctMonths.size > 0) {
    const reports = await prisma.monthlyTaxReport.findMany({
      where: {
        businessId,
        taxMonth: { in: Array.from(distinctMonths.values()) },
        OR: [{ isLocked: true }, { isFinalized: true }],
      },
      select: { taxMonth: true },
    });
    for (const rep of reports) nowLocked.add(monthStart(rep.taxMonth).toISOString());
  }

  const toInsert = cached.rows.filter(
    (r) => !nowLocked.has(monthStart(r.transactionDate).toISOString())
  );
  const skippedLockedAtCommit = cached.rows.length - toInsert.length;

  const result = await prisma.$transaction(async (tx) => {
    const createResult = await tx.salesTransaction.createMany({
      data: toInsert.map((r) => ({
        businessId,
        amount: r.amount,
        source: r.source,
        status: 'confirmed' as const,
        referenceId: r.referenceId,
        description: r.description,
        customerName: r.customerName,
        transactionDate: r.transactionDate,
        createdBy: userId,
      })),
      skipDuplicates: true, // DB unique (businessId, source, referenceId) is final guard
    });

    const imported = createResult.count;
    const skippedRaceDuplicates = toInsert.length - imported;

    logAudit(
      {
        userId,
        businessId,
        action: 'sales.imported',
        resourceType: 'sales_transaction',
        newData: {
          filename: cached.filename,
          imported,
          skippedRaceDuplicates,
          skippedLockedAtCommit,
          invalid: cached.invalidRows.length,
          duplicateInFile: cached.duplicateInFile.length,
          duplicateInDb: cached.duplicateInDb.length,
          lockedMonth: cached.lockedMonth.length,
        },
      },
      tx
    );

    return { imported, skippedRaceDuplicates };
  });

  dropImport(fileToken);

  logger.info('Sales import committed', {
    userId,
    businessId,
    filename: cached.filename,
    imported: result.imported,
    skippedLockedAtCommit,
    skippedRaceDuplicates: result.skippedRaceDuplicates,
  });

  return {
    imported: result.imported,
    skippedRaceDuplicates: result.skippedRaceDuplicates,
    skippedLockedAtCommit,
    invalidCount: cached.invalidRows.length,
    duplicateInFileCount: cached.duplicateInFile.length,
    duplicateInDbCount: cached.duplicateInDb.length,
    lockedMonthCount: cached.lockedMonth.length,
  };
}

export const SUPPORTED_SOURCES = SALES_IMPORT_SOURCES;
