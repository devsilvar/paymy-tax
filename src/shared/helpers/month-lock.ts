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
