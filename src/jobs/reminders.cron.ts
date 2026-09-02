// Daily reminder sweep — runs at 00:30 Africa/Lagos.
//
// Two phases, both idempotent:
//   1. generateRemindersForAllBusinesses() — tax_deadline / unfiled_tax /
//      unfinalized_report / unpaid_tax for every business whose
//      taxReminderDay matches today.
//   2. sweepOverdueInvoicesForBusiness() (no businessId = all) — flips
//      `sent` invoices past their dueDate to `overdue` AND creates an
//      `invoice_overdue` reminder.
//
// The actual sweep logic lives in reminder.service.ts so the manual
// "Generate Reminders" button on /reminders can reuse it for one
// business. This file is just the scheduler + concurrency guard.
//
// Concurrency: the whole sweep is wrapped in a Postgres advisory lock
// (LOCK_KEY = 947362). Future multi-instance deploys will not double-run.
// Lock release sits in `finally`; Postgres also releases on session close
// if the Node process crashes mid-sweep.
//
// Gating: registerReminderCron() is a no-op unless config.cron.enabled.
// Default: true in production, false in dev (set ENABLE_CRON=true to
// override locally — otherwise `tsx watch` would re-register on every
// file save and spam logs).

import cron from 'node-cron';
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import config from '@/config';
import {
  generateRemindersForAllBusinesses,
  sweepOverdueInvoicesForBusiness,
} from '@/services/reminder.service';
import { sweepStalePayouts } from '@/services/settlement.service';

// Arbitrary 32-bit int. Document new lock keys here so they don't collide.
//   947362 — daily reminder sweep
const LOCK_KEY = 947362;

// 00:30 daily, Africa/Lagos. node-cron honors `timezone` even on UTC hosts.
const SCHEDULE = '30 0 * * *';
const TIMEZONE = 'Africa/Lagos';

export function registerReminderCron(): void {
  if (!config.cron.enabled) {
    logger.info(
      'Reminder cron skipped (set ENABLE_CRON=true to enable in non-production)'
    );
    return;
  }

  cron.schedule(SCHEDULE, runDailySweep, { timezone: TIMEZONE });
  logger.info('Reminder cron registered', { schedule: SCHEDULE, timezone: TIMEZONE });
}

// Exported so a one-off `tsx` script or future test can run the sweep
// directly without waiting for the scheduler.
export async function runDailySweep(): Promise<void> {
  const lockResult = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
  `;
  const locked = lockResult[0]?.locked === true;

  if (!locked) {
    logger.info('Reminder cron sweep: lock held, skipping');
    return;
  }

  logger.info('Reminder cron sweep: start');

  try {
    const tax = await generateRemindersForAllBusinesses();
    const invoice = await sweepOverdueInvoicesForBusiness();
    const stalePayouts = await sweepStalePayouts();

    logger.info('Reminder cron sweep: done', {
      businessesProcessed: tax.processed,
      taxRemindersCreated: tax.created,
      deadlinesCreated: tax.deadlinesCreated,
      invoiceRemindersCreated: invoice.remindersCreated,
      invoicesFlippedToOverdue: invoice.statusFlipped,
      stalePayouts: {
        checked: stalePayouts.checked,
        completed: stalePayouts.completed,
        failed: stalePayouts.failed,
        stillPending: stalePayouts.stillPending,
      },
    });
  } catch (err) {
    logger.error('Reminder cron sweep: failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    try {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    } catch (unlockErr) {
      // Postgres releases the lock on session close anyway; just log.
      logger.warn('Reminder cron sweep: advisory unlock failed', {
        error: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
      });
    }
  }
}
