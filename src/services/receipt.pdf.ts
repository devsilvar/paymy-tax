/**
 * PDF Receipt Generation Facade
 *
 * Maintains 100% backward compatibility with all receipt and payment services.
 * Decomposed into modular PDF generators:
 * - pdf/receipt-common.pdf.ts: Design tokens, layout constants, and formatting utilities
 * - pdf/tax-payment-receipt.pdf.ts: Official FIRS and custody tax payment receipts
 * - pdf/dva-receipt.pdf.ts: Customer-facing credit advices for DVA bank transfers
 * - pdf/sales-receipt.pdf.ts: Itemized receipts for point-of-sale and invoice transactions
 */

export * from './pdf/receipt-common.pdf';
export * from './pdf/tax-payment-receipt.pdf';
export * from './pdf/dva-receipt.pdf';
export * from './pdf/sales-receipt.pdf';
