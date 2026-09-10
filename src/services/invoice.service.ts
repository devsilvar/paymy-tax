/**
 * Canonical facade for invoice services.
 * Decomposed into focused domain services per refactor guidelines:
 * - invoice-crud.service: Invoice calculations, sequence numbers, lifecycle states, payments
 * - invoice-delivery.service: WhatsApp dispatch, public share tokens, and PDF streaming
 */
export * from './invoice/invoice-crud.service';
export * from './invoice/invoice-delivery.service';
