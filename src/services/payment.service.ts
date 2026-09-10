/**
 * Payment Service Facade
 *
 * Maintains 100% backward compatibility with all controllers, routes, and background jobs.
 * Decomposed into modular domain services:
 * - tax-payment.service.ts: Payment initialization, verification, and lifecycle management
 * - payment-webhook.service.ts: Paystack webhook verification, replay prevention, and event routing
 */

export * from './payment/tax-payment.service';
export * from './payment/payment-webhook.service';