/**
 * Canonical facade for Payout services.
 * Decomposed into focused domain services per refactor guidelines:
 * - merchant-payout.service: Merchant withdrawal requests and payout history
 * - admin-payout.service: Admin withdrawal approval queue, rejection, requery, and auto-payout configuration
 */
export * from './merchant-payout.service';
export * from './admin-payout.service';
