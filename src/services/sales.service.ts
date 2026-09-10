/**
 * Canonical facade for sales services.
 * Decomposed into focused domain services per refactor guidelines:
 * - sales-crud.service: Basket calculations, create, read, update, delete
 * - sales-verification.service: DVA auto-capture triage, verification, and business reassignment
 * - sales-analytics.service: Monthly, daily, and multi-period financial timeline overviews
 */
export * from './sales/sales-crud.service';
export * from './sales/sales-verification.service';
export * from './sales/sales-analytics.service';
