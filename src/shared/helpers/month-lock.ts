import prisma, { TxClient } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

/**
 * Asserts that the month corresponding to the given date is neither finalized nor locked.
 *
 * Checks `MonthlyTaxReport` for the given business and month (normalized to UTC month start).
 * - Throws 423 PERIOD_LOCKED if the report is locked (tax already paid).
 * - Throws 423 PERIOD_FINALIZED if the report is finalized.
 *
 * @param businessId - Business UUID
 * @param date - Transaction or expense date
 * @param db - Database client (accepts TxClient or default prisma singleton)
 */
export async function assertMonthNotLocked(
  businessId: string,
  date: Date,
  db: TxClient | typeof prisma = prisma
): Promise<void> {
  // UTC — taxMonth is written in UTC by calculateTax; using local-tz
  // derivation here would miss the row on UTC+ hosts and silently allow
  // edits to a locked/finalized month.
  const monthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  );

  const report = await db.monthlyTaxReport.findUnique({
    where: {
      businessId_taxMonth: {
        businessId,
        taxMonth: monthStart,
      },
    },
    select: { isLocked: true, isFinalized: true },
  });

  if (report?.isLocked) {
    throw new AppError(
      423,
      'This month is locked — tax has been paid. No edits allowed.',
      'PERIOD_LOCKED'
    );
  }

  if (report?.isFinalized) {
    throw new AppError(
      423,
      'This month has been finalized. Unfinalize the report before making changes.',
      'PERIOD_FINALIZED'
    );
  }
}

/**
 * Checks whether the month corresponding to the given date is finalized or locked.
 */
export async function isMonthLockedOrFinalized(
  businessId: string,
  date: Date,
  db: TxClient | typeof prisma = prisma
): Promise<{ isLocked: boolean; isFinalized: boolean; lockedOrFinalized: boolean }> {
  const monthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  );

  const report = await db.monthlyTaxReport.findUnique({
    where: {
      businessId_taxMonth: {
        businessId,
        taxMonth: monthStart,
      },
    },
    select: { isLocked: true, isFinalized: true },
  });

  const isLocked = Boolean(report?.isLocked);
  const isFinalized = Boolean(report?.isFinalized);
  return { isLocked, isFinalized, lockedOrFinalized: isLocked || isFinalized };
}

export interface ResolveTransactionDateResult {
  effectiveDate: Date;
  wasAdjusted: boolean;
  originalDate?: Date;
  reason?: string;
}

/**
 * Ensures a sales transaction date does not land in a locked/finalized tax month.
 * If the target month is locked or finalized, adjusts the date to the current active month (today)
 * and returns adjustment metadata for regulatory transparency.
 */
export async function resolveTransactionDateForLockedMonth(
  businessId: string,
  enteredDate: Date,
  db: TxClient | typeof prisma = prisma
): Promise<ResolveTransactionDateResult> {
  const check = await isMonthLockedOrFinalized(businessId, enteredDate, db);
  if (!check.lockedOrFinalized) {
    return { effectiveDate: enteredDate, wasAdjusted: false };
  }

  const today = new Date();
  const reason = check.isLocked
    ? 'Entered date was in a locked tax period (tax already remitted); transaction date adjusted to current active month'
    : 'Entered date was in a finalized tax period; transaction date adjusted to current active month';

  return {
    effectiveDate: today,
    wasAdjusted: true,
    originalDate: enteredDate,
    reason,
  };
}

