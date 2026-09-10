import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { verifyBusinessOwnership } from '@/lib/ownership';

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
