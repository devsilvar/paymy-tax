/**
 * Tax Service Facade
 *
 * Maintains 100% backward compatibility with all controllers, routes, and background jobs.
 * Decomposed into modular domain services:
 * - tax-report.service.ts: Monthly tax report calculation, CRUD, finalization, reset, and slip download
 * - tax-analytics.service.ts: Dashboard metrics, aggregates, visual history, and YoY analytics
 */

export * from './tax/tax-report.service';
export * from './tax/tax-analytics.service';
