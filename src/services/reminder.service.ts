import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { formatNaira, formatDateISO } from '@/lib/format';

// ─── Helpers ────────────────────────────────────────────────

async function verifyBusinessOwnership(
  userId: string,
  businessId: string,
  db: TxClient | typeof prisma = prisma
) {
  const business = await db.business.findUnique({ where: { id: businessId } });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  return business;
}

// ─── Reminder Types ─────────────────────────────────────────
//
// tax_deadline        — monthly tax filing/payment is approaching
// unfiled_tax         — month ended and no tax report was calculated
// unfinalized_report  — report calculated but not finalized
// unpaid_tax          — report finalized but not paid
// margin_warning      — fired during tax calc when expenses look anomalous
// invoice_overdue     — sent invoice past its due date
// payment_successful  — tax payment confirmed (webhook or manual verify)
// dva_received        — DVA auto-captured a sale

export type ReminderType =
  | 'tax_deadline'
  | 'unfiled_tax'
  | 'unfinalized_report'
  | 'unpaid_tax'
  | 'margin_warning'
  | 'invoice_overdue'
  | 'payment_successful'
  | 'payment_refunded'
  | 'dva_received'
  | 'dva_validation_failed'
  | 'transaction_needs_verification';

export type ReminderReferenceType = 'invoice' | 'payment' | 'sales_transaction' | 'business';

const REPORT_REMINDER_MESSAGES: Record<
  'tax_deadline' | 'unfiled_tax' | 'unfinalized_report' | 'unpaid_tax',
  (month: string) => string
> = {
  tax_deadline: (month) =>
    `Your tax filing deadline for ${month} is approaching. Calculate and finalize your tax report to avoid delays.`,
  unfiled_tax: (month) =>
    `You haven't calculated your tax report for ${month} yet. Record your sales and expenses, then calculate your tax.`,
  unfinalized_report: (month) =>
    `Your tax report for ${month} has been calculated but not finalized. Review and finalize it to proceed with payment.`,
  unpaid_tax: (month) =>
    `Your tax report for ${month} is finalized but unpaid. Complete your tax payment to stay compliant.`,
};

function formatMonth(month: number, year: number): string {
  // UTC to match the rest of the service. Display formatters below pin the
  // timezone explicitly so the label reads correctly regardless of host TZ.
  const date = new Date(Date.UTC(year, month - 1, 1));
  return date.toLocaleDateString('en-NG', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ─── Determine which report-state reminder is needed ────────
//
// Shared by generateReminders (single business, on-demand) and
// generateRemindersForAllBusinesses (cron, all businesses).

type ReportReminderType = 'unfiled_tax' | 'unfinalized_report' | 'unpaid_tax';

function determineReportReminderType(
  report: { isFinalized: boolean; isLocked: boolean; paymentStatus: string } | null
): ReportReminderType | null {
  if (!report) return 'unfiled_tax';
  if (!report.isFinalized) return 'unfinalized_report';
  if (report.paymentStatus === 'pending' && !report.isLocked) return 'unpaid_tax';
  return null;
}

// ─── createReminderOnce — centralized creator with dedup ────
//
// Two dedup keys depending on whether a referenceId is supplied:
//   • With ref:    (businessId, reminderType, referenceType, referenceId)
//                  → one reminder per real-world entity (e.g. one per invoice)
//   • Without ref: (businessId, reminderType, scheduledDate)
//                  → one reminder per month (existing behaviour)
//
// `updateMessageOnDup` opt-in lets margin_warning refresh its numbers on
// recalculation without spawning duplicate rows.

interface CreateReminderOnceParams {
  businessId: string;
  reminderType: ReminderType;
  scheduledDate: Date;
  message: string;
  referenceType?: ReminderReferenceType;
  referenceId?: string;
  updateMessageOnDup?: boolean;
}

export interface CreateReminderOnceResult {
  created: boolean;
  reminder: Awaited<ReturnType<typeof prisma.reminder.create>>;
}

export async function createReminderOnce(
  p: CreateReminderOnceParams
): Promise<CreateReminderOnceResult> {
  const where = p.referenceId
    ? {
        businessId: p.businessId,
        reminderType: p.reminderType,
        referenceType: p.referenceType ?? null,
        referenceId: p.referenceId,
      }
    : {
        businessId: p.businessId,
        reminderType: p.reminderType,
        scheduledDate: p.scheduledDate,
      };

  const existing = await prisma.reminder.findFirst({ where });

  if (existing) {
    if (p.updateMessageOnDup && existing.message !== p.message) {
      const updated = await prisma.reminder.update({
        where: { id: existing.id },
        data: { message: p.message },
      });
      return { created: false, reminder: updated };
    }
    return { created: false, reminder: existing };
  }

  const reminder = await prisma.reminder.create({
    data: {
      businessId: p.businessId,
      reminderType: p.reminderType,
      scheduledDate: p.scheduledDate,
      message: p.message,
      referenceType: p.referenceType ?? null,
      referenceId: p.referenceId ?? null,
    },
  });

  return { created: true, reminder };
}

// ─── Generate Reminders for a Business (manual / on-demand) ─
//
// Same scope as the nightly cron, scoped to one business:
//   1. Tax-state reminder for the requested month (unfiled / unfinalized / unpaid)
//   2. Tax-deadline reminder if today >= business.taxReminderDay
//   3. Overdue-invoice sweep for every sent invoice past dueDate
//
// Returns counts so the UI can show a meaningful summary.

export async function generateReminders(
  userId: string,
  businessId: string,
  month: number,
  year: number
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // UTC — must match the UTC bounds used by calculateTax so the unique-key
  // lookup on (businessId, taxMonth) hits the right row, and so the reminder's
  // scheduledDate (also @db.Date) stores the calendar month the user meant.
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthLabel = formatMonth(month, year);

  // 1. Tax-state reminder for the requested month
  const report = await prisma.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId, taxMonth: monthStart } },
    select: {
      isFinalized: true,
      isLocked: true,
      paymentStatus: true,
      taxPayable: true,
    },
  });

  const reminderType = determineReportReminderType(report);

  let taxReminderCreated = false;
  let taxReminderType: ReportReminderType | null = null;

  if (reminderType) {
    const res = await createReminderOnce({
      businessId,
      reminderType,
      scheduledDate: monthStart,
      message: REPORT_REMINDER_MESSAGES[reminderType](monthLabel),
    });

    if (res.created) {
      taxReminderCreated = true;
      taxReminderType = reminderType;
      logAudit({
        userId,
        businessId,
        action: 'reminder.created',
        resourceType: 'reminder',
        resourceId: res.reminder.id,
        newData: { reminderType, month, year },
      });
      logger.info('Reminder created', {
        reminderId: res.reminder.id,
        businessId,
        reminderType,
        month,
        year,
      });
    }
  }

  // 2. Tax-deadline reminder (independent of report state)
  let deadlineCreated = false;
  const deadline = await checkDeadlineReminderForBusiness(business);
  if (deadline?.created) {
    deadlineCreated = true;
  }

  // 3. Overdue-invoice sweep for this business
  const invoiceSweep = await sweepOverdueInvoicesForBusiness(businessId);

  const totalCreated =
    (taxReminderCreated ? 1 : 0) +
    (deadlineCreated ? 1 : 0) +
    invoiceSweep.remindersCreated;

  return {
    created: totalCreated > 0,
    taxReminderType,
    taxReminderCreated,
    deadlineCreated,
    invoiceRemindersCreated: invoiceSweep.remindersCreated,
    invoicesFlippedToOverdue: invoiceSweep.statusFlipped,
    totalCreated,
    message:
      totalCreated === 0
        ? 'You are all caught up — no new reminders.'
        : `Created ${totalCreated} reminder${totalCreated === 1 ? '' : 's'}.`,
  };
}

// ─── Generate Deadline Reminder for a single business ───────
//
// Creates a "tax_deadline" reminder when today >= taxReminderDay
// and the current month's tax isn't already settled.

export async function checkDeadlineReminder(
  userId: string,
  businessId: string
) {
  const business = await verifyBusinessOwnership(userId, businessId);
  const result = await checkDeadlineReminderForBusiness(business);
  return result?.reminder ?? null;
}

// Internal variant that skips ownership check — for cron use.
// Returns { created, reminder } | null when no reminder is needed.
async function checkDeadlineReminderForBusiness(business: {
  id: string;
  taxReminderDay: number;
}): Promise<CreateReminderOnceResult | null> {
  const now = new Date();
  const today = now.getDate();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (today < business.taxReminderDay) {
    return null;
  }

  // UTC-bounded so the unique-key lookup on (businessId, taxMonth) — which
  // calculateTax writes in UTC — actually hits. `currentMonth/Year` are still
  // local-tz because the "is today >= reminderDay?" check above is naturally a
  // local-calendar question; the host runs in Lagos TZ (Render env: `TZ=Africa/Lagos`)
  // so local == Lagos and the two agree. If we ever ship to a non-Lagos host,
  // recompute today/currentMonth/currentYear in the Lagos zone explicitly.
  const monthStart = new Date(Date.UTC(currentYear, currentMonth - 1, 1));

  const report = await prisma.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId: business.id, taxMonth: monthStart } },
    select: { isLocked: true, paymentStatus: true },
  });

  if (report?.isLocked || report?.paymentStatus === 'completed') {
    return null;
  }

  const monthLabel = formatMonth(currentMonth, currentYear);

  const result = await createReminderOnce({
    businessId: business.id,
    reminderType: 'tax_deadline',
    scheduledDate: monthStart,
    message: REPORT_REMINDER_MESSAGES.tax_deadline(monthLabel),
  });

  if (result.created) {
    logger.info('Deadline reminder auto-created', {
      reminderId: result.reminder.id,
      businessId: business.id,
    });
  }

  return result;
}

// ─── Batch: Generate Reminders for ALL Businesses (cron) ────
//
// Daily sweep: for every business whose taxReminderDay is today,
// create the right report-state reminder (unfiled / unfinalized / unpaid)
// AND a tax_deadline reminder if appropriate. Idempotent.

export async function generateRemindersForAllBusinesses() {
  const now = new Date();
  const today = now.getDate();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  // UTC bounds for the same reason as checkDeadlineReminderForBusiness — must
  // align with calculateTax's UTC taxMonth so the unique-key lookup hits.
  const monthStart = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
  const monthLabel = formatMonth(currentMonth, currentYear);

  const businesses = await prisma.business.findMany({
    where: { taxReminderDay: today },
    select: {
      id: true,
      userId: true,
      businessName: true,
      taxReminderDay: true,
    },
  });

  if (businesses.length === 0) {
    logger.info('No businesses have reminder day today', { today });
    return { processed: 0, created: 0, deadlinesCreated: 0 };
  }

  let created = 0;
  let deadlinesCreated = 0;

  for (const business of businesses) {
    // Report-state reminder
    const report = await prisma.monthlyTaxReport.findUnique({
      where: { businessId_taxMonth: { businessId: business.id, taxMonth: monthStart } },
      select: { isFinalized: true, isLocked: true, paymentStatus: true },
    });

    const reminderType = determineReportReminderType(report);

    if (reminderType) {
      const res = await createReminderOnce({
        businessId: business.id,
        reminderType,
        scheduledDate: monthStart,
        message: REPORT_REMINDER_MESSAGES[reminderType](monthLabel),
      });
      if (res.created) {
        created++;
        logger.info('Batch reminder created', { businessId: business.id, reminderType });
      }
    }

    // Tax deadline reminder (independent of report state — fires whether or
    // not the report exists, as long as the month isn't already paid/locked).
    const deadline = await checkDeadlineReminderForBusiness(business);
    if (deadline?.created) {
      deadlinesCreated++;
    }
  }

  logger.info('Batch reminder generation complete', {
    processed: businesses.length,
    created,
    deadlinesCreated,
  });

  return { processed: businesses.length, created, deadlinesCreated };
}

// ─── Margin Warning Helper ───────────────────────────────────
//
// Called from tax.service.ts during calculation. Refreshes the message
// when numbers change on recalculation rather than spamming new rows.

export async function createMarginWarning(
  businessId: string,
  message: string,
  month: number,
  year: number
) {
  // UTC — matches calculateTax's UTC monthStart so dedup on
  // (businessId, type, scheduledDate) lines up with the reminder this
  // function refreshed last calculation.
  const monthStart = new Date(Date.UTC(year, month - 1, 1));

  const { created, reminder } = await createReminderOnce({
    businessId,
    reminderType: 'margin_warning',
    scheduledDate: monthStart,
    message,
    updateMessageOnDup: true,
  });

  if (created) {
    logger.info('Margin warning created', { reminderId: reminder.id, businessId, month, year });
  }

  return reminder;
}

// ─── Sweep Overdue Invoices ─────────────────────────────────
//
// For every Invoice with status='sent' AND dueDate < startOfToday:
//   1. Create one `invoice_overdue` reminder (deduped by referenceId)
//   2. Flip Invoice.status: 'sent' → 'overdue'
//
// Both moves are idempotent:
//   • createReminderOnce dedupes on (businessId, type, referenceType, referenceId)
//   • updateMany filters on status='sent' so already-flipped rows are no-ops
//
// Per-invoice try/catch — one bad row never aborts the sweep.
//
// `businessId` is optional: omitted = walk every business (used by the
// nightly cron); supplied = scoped to one business (used by the manual
// "Generate Reminders" button on /reminders).

export interface InvoiceSweepResult {
  remindersCreated: number;
  statusFlipped: number;
}

export async function sweepOverdueInvoicesForBusiness(
  businessId?: string
): Promise<InvoiceSweepResult> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const invoices = await prisma.invoice.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      status: 'sent',
      dueDate: { lt: today },
    },
    select: {
      id: true,
      businessId: true,
      invoiceNumber: true,
      customerName: true,
      total: true,
      dueDate: true,
    },
  });

  let remindersCreated = 0;
  let statusFlipped = 0;

  for (const inv of invoices) {
    try {
      const reminderRes = await createReminderOnce({
        businessId: inv.businessId,
        reminderType: 'invoice_overdue',
        scheduledDate: today,
        message: `Invoice ${inv.invoiceNumber} to ${inv.customerName} for ${formatNaira(
          inv.total as unknown as number
        )} is overdue (was due ${formatDateISO(inv.dueDate)}).`,
        referenceType: 'invoice',
        referenceId: inv.id,
      });

      const updateRes = await prisma.invoice.updateMany({
        where: { id: inv.id, status: 'sent' },
        data: { status: 'overdue' },
      });

      if (reminderRes.created) remindersCreated++;
      if (updateRes.count > 0) statusFlipped++;
    } catch (err) {
      logger.warn('Overdue invoice sweep: invoice failed', {
        invoiceId: inv.id,
        businessId: inv.businessId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { remindersCreated, statusFlipped };
}

// ─── List Reminders ─────────────────────────────────────────

export async function listReminders(
  userId: string,
  businessId: string,
  query: { page: number; limit: number; status: string }
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };

  if (query.status === 'pending') {
    where.isSent = false;
  } else if (query.status === 'sent') {
    where.isSent = true;
  }

  const offset = (query.page - 1) * query.limit;

  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({
      where,
      skip: offset,
      take: query.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.reminder.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: reminders,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: query.page < totalPages,
      hasPrev: query.page > 1,
    },
  };
}

// ─── Mark Reminder as Sent ──────────────────────────────────

export async function markReminderSent(
  userId: string,
  businessId: string,
  reminderId: string
) {
  await verifyBusinessOwnership(userId, businessId);

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });

  if (!reminder || reminder.businessId !== businessId) {
    throw new AppError(404, 'Reminder not found', 'REMINDER_NOT_FOUND');
  }

  if (reminder.isSent) {
    return reminder; // Already marked, idempotent
  }

  const updated = await prisma.reminder.update({
    where: { id: reminderId },
    data: { isSent: true, sentAt: new Date() },
  });

  logger.info('Reminder marked as sent', { reminderId, businessId });

  return updated;
}

// ─── Dismiss (Delete) a Reminder ────────────────────────────

export async function dismissReminder(
  userId: string,
  businessId: string,
  reminderId: string
) {
  await verifyBusinessOwnership(userId, businessId);

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });

  if (!reminder || reminder.businessId !== businessId) {
    throw new AppError(404, 'Reminder not found', 'REMINDER_NOT_FOUND');
  }

  await prisma.reminder.delete({ where: { id: reminderId } });

  logAudit({
    userId,
    businessId,
    action: 'reminder.dismissed',
    resourceType: 'reminder',
    resourceId: reminderId,
    oldData: { reminderType: reminder.reminderType },
  });

  logger.info('Reminder dismissed', { reminderId, businessId });

  return { message: 'Reminder dismissed successfully' };
}

// ─── Get Active Reminders (for top-bar bell) ────────────────
//
// Pure-read: returns unsent reminders for the current and previous month.
// Reminder creation is owned by the daily cron + event-driven creators;
// this endpoint never mutates.

export async function getActiveReminders(userId: string, businessId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const now = new Date();
  // UTC — scheduledDate is @db.Date (UTC); filtering with a local-tz
  // boundary on a UTC+ host shifts the cutoff by a day and the previous
  // month's reminders quietly drop off the bell.
  const prevMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );

  const reminders = await prisma.reminder.findMany({
    where: {
      businessId,
      isSent: false,
      scheduledDate: { gte: prevMonthStart },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  return reminders;
}
