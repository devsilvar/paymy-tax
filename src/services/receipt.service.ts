import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { logAudit } from '@/lib/audit';
import {
  buildTaxPaymentReceiptPdf,
  buildDvaTransferReceiptPdf,
  buildSalesReceiptPdf,
  TaxPaymentReceiptData,
  DvaTransferReceiptData,
  SalesReceiptData,
} from './receipt.pdf';

function toNumber(val: any): number {
  if (val === null || val === undefined) return 0;
  return typeof val === 'number' ? val : Number(val);
}

/**
 * Generate a deterministic or sequential receipt number.
 */
function generateReceiptNumber(prefix: string, date: Date, id: string): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const shortId = id.replace(/-/g, '').slice(-5).toUpperCase();
  return `${prefix}-${year}${month}-${shortId}`;
}

/**
 * Generates the PDF buffer and metadata for a Tax Payment Receipt (Stage 1 or Stage 2).
 */
export async function getTaxPaymentReceipt(
  userId: string,
  businessId: string,
  paymentId: string
): Promise<{ buffer: Buffer; filename: string; receiptNumber: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const payment = await prisma.taxPayment.findUnique({
    where: { id: paymentId },
    include: {
      taxReport: true,
      remittance: true,
    },
  });

  if (!payment || payment.businessId !== businessId) {
    throw new AppError(404, 'Tax payment not found', 'PAYMENT_NOT_FOUND');
  }

  if (payment.paymentStatus !== 'completed') {
    throw new AppError(400, 'Receipt is only available for completed payments', 'PAYMENT_NOT_COMPLETED');
  }

  const paymentDate = payment.paymentDate || payment.createdAt;
  const receiptNumber = generateReceiptNumber('RCT-TAX', paymentDate, payment.id);

  const receiptData: TaxPaymentReceiptData = {
    receiptNumber,
    paymentReference: payment.transactionReference,
    paymentDate,
    amount: toNumber(payment.amountPaid),
    paymentMethod: payment.paymentMethod || 'card',
    remittanceStatus: (payment.remittanceStatus as any) || 'collected',
    firsRemittanceRef: payment.firsRemittanceRef || payment.remittance?.firsReference || null,
    firsReceiptUrl: payment.firsReceiptUrl || payment.remittance?.firsReceiptUrl || null,
    business: {
      businessName: business.businessName,
      ownerName: business.ownerName,
      merchantId: business.merchantId,
      taxId: business.taxId,
      address: business.address ? `${business.address}${business.city ? ', ' + business.city : ''}` : null,
      logoUrl: business.logoUrl,
    },
    taxReport: {
      taxMonth: payment.taxReport.taxMonth,
      totalSales: toNumber(payment.taxReport.totalSales),
      totalExpenses: toNumber(payment.taxReport.totalExpenses),
      grossProfit: toNumber(payment.taxReport.grossProfit),
      taxRate: toNumber(payment.taxReport.taxRate),
      taxPayable: toNumber(payment.taxReport.taxPayable),
    },
  };

  const buffer = await buildTaxPaymentReceiptPdf(receiptData);
  const filename = `${receiptNumber}.pdf`;

  // Audit receipt download
  logAudit({
    userId,
    businessId,
    action: 'receipt.downloaded',
    resourceType: 'tax_payment_receipt',
    resourceId: payment.id,
    newData: { receiptNumber, remittanceStatus: payment.remittanceStatus },
  });

  logger.info('Tax payment receipt generated', { paymentId, receiptNumber, businessId });

  return { buffer, filename, receiptNumber };
}

/**
 * Generates the PDF buffer and metadata for a DVA Inbound Bank Transfer Receipt.
 */
export async function getDvaTransferReceipt(
  userId: string,
  businessId: string,
  saleId: string
): Promise<{ buffer: Buffer; filename: string; receiptNumber: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const sale = await prisma.salesTransaction.findUnique({
    where: { id: saleId },
  });

  if (!sale || sale.businessId !== businessId) {
    throw new AppError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  }

  if (sale.source !== 'bank_transfer') {
    throw new AppError(400, 'Transfer receipt is only available for bank transfer transactions', 'INVALID_TRANSACTION_SOURCE');
  }

  const transactionDate = sale.transactionDate || sale.createdAt;
  const receiptNumber = generateReceiptNumber('RCT-DVA', transactionDate, sale.id);

  const receiptData: DvaTransferReceiptData = {
    receiptNumber,
    transactionReference: sale.referenceId || sale.id,
    transactionDate,
    amount: toNumber(sale.amount),
    customerName: sale.customerName,
    customerHint: sale.customerHint,
    virtualAccountNumber: business.virtualAccountNumber || 'Dedicated NUBAN',
    virtualAccountBank: business.virtualAccountBank || 'Wema Bank',
    business: {
      businessName: business.businessName,
      ownerName: business.ownerName,
      merchantId: business.merchantId,
      taxId: business.taxId,
      logoUrl: business.logoUrl,
    },
  };

  const buffer = await buildDvaTransferReceiptPdf(receiptData);
  const filename = `${receiptNumber}.pdf`;

  logAudit({
    userId,
    businessId,
    action: 'receipt.downloaded',
    resourceType: 'dva_transfer_receipt',
    resourceId: sale.id,
    newData: { receiptNumber },
  });

  logger.info('DVA transfer receipt generated', { saleId, receiptNumber, businessId });

  return { buffer, filename, receiptNumber };
}



/**
 * Generates a universal PDF receipt for ANY sales transaction (bank transfer, cash, POS, invoice, etc.)
 */
export async function getSalesReceipt(
  userId: string,
  businessId: string,
  saleId: string
): Promise<{ buffer: Buffer; filename: string; receiptNumber: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const sale = await prisma.salesTransaction.findUnique({
    where: { id: saleId },
  });

  if (!sale || sale.businessId !== businessId) {
    throw new AppError(404, 'Sales transaction not found', 'TRANSACTION_NOT_FOUND');
  }

  const transactionDate = sale.transactionDate || sale.createdAt;
  const receiptNumber = generateReceiptNumber('RCT-SALE', transactionDate, sale.id);

  // Map source to human-readable labels
  const sourceLabels: Record<string, string> = {
    bank_transfer: 'Bank Transfer (DVA)',
    paycode: 'Paystack Paycode',
    pos: 'POS Terminal',
    online_store: 'Online Store Payment',
    manual: 'Manual Entry / Cash',
    cash: 'Cash Payment',
    invoice: 'Invoice Payment',
  };

  const receiptData: import('./receipt.pdf').SalesReceiptData = {
    receiptNumber,
    transactionReference: sale.referenceId,
    transactionDate,
    amount: toNumber(sale.amount),
    source: sale.source as any,
    sourceLabel: sourceLabels[sale.source] || sale.source,
    customerName: sale.customerName,
    description: sale.description,
    invoiceNumber: sale.source === 'invoice' ? sale.referenceId : null,
    business: {
      businessName: business.businessName,
      ownerName: business.ownerName,
      merchantId: business.merchantId,
      taxId: business.taxId,
      address: business.address && business.city 
        ? `${business.address}, ${business.city}${business.state ? ', ' + business.state : ''}` 
        : business.address || null,
      logoUrl: business.logoUrl,
    },
  };

  const { buildSalesReceiptPdf } = await import('./receipt.pdf');
  const buffer = await buildSalesReceiptPdf(receiptData);
  const filename = `${receiptNumber}.pdf`;

  logAudit({
    userId,
    businessId,
    action: 'receipt.downloaded',
    resourceType: 'sales_receipt',
    resourceId: sale.id,
    newData: { receiptNumber, source: sale.source },
  });

  logger.info('Sales receipt generated', { saleId, receiptNumber, source: sale.source, businessId });

  return { buffer, filename, receiptNumber };
}
