/**
 * Canonical facade for DVA (Dedicated Virtual Account) services.
 * Decomposed into focused domain services per refactor guidelines:
 * - dva-account.service: Customer KYC/BVN validation, setup, balance, resolution, and transactions
 * - dva-webhook.service: Paystack asynchronous webhooks (assignment, identification, transfer auto-capture)
 */
export * from './dva/dva-account.service';
export * from './dva/dva-webhook.service';
