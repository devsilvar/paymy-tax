/**
 * Reminder Service Facade
 *
 * Maintains 100% backward compatibility with all controllers, routes, cron jobs, and background workers.
 * Decomposed into modular domain services:
 * - reminder-generation.service.ts: Automated and manual reminder creation, dedup, tax deadline checks, and overdue invoice sweeping
 * - reminder-actions.service.ts: Querying active reminders, paginated listing, mark-as-read, and dismissal
 */

export * from './reminder/reminder-generation.service';
export * from './reminder/reminder-actions.service';
