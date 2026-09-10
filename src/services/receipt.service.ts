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
import { toNumber } from '@/shared/helpers';

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
      address: business.address && business.city 
        ? `${business.address}, ${business.city}${business.state ? ', ' + business.state : ''}` 
        : business.address || null,
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
 * Generates an official itemized PDF receipt for ANY sales transaction (cash, POS, online, invoice, etc.)
 */
export async function getSalesReceipt(
  userId: string,
  businessId: string,
  saleId: string
): Promise<{ buffer: Buffer; filename: string; receiptNumber: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const sale = await prisma.salesTransaction.findUnique({
    where: { id: saleId },
    include: {
      items: { orderBy: { sortOrder: 'asc' } },
      invoice: {
        include: {
          lines: { orderBy: { sortOrder: 'asc' } },
        },
      },
    },
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
    manual: 'Cash / Manual Entry',
    cash: 'Cash Payment',
    invoice: 'Invoice Payment',
  };

  // Build items hierarchy
  let items: Array<{ name: string; quantity: number; unitPrice: number; lineTotal: number }> = [];
  let subtotal = toNumber(sale.amount);
  let discount = 0;
  let vatRate = 0;
  let vatAmount = 0;
  let customerPhone: string | null = null;
  let customerEmail: string | null = null;
  let customerAddress: string | null = null;

  if (sale.items && sale.items.length > 0) {
    items = sale.items.map((item) => ({
      name: item.name,
      quantity: toNumber(item.quantity),
      unitPrice: toNumber(item.unitPrice),
      lineTotal: toNumber(item.lineTotal),
    }));
    subtotal = items.reduce((sum, it) => sum + it.lineTotal, 0);
  } else if (sale.invoice && sale.invoice.lines && sale.invoice.lines.length > 0) {
    items = sale.invoice.lines.map((line) => ({
      name: line.description,
      quantity: toNumber(line.quantity),
      unitPrice: toNumber(line.unitPrice),
      lineTotal: toNumber(line.lineTotal),
    }));
    subtotal = toNumber(sale.invoice.subtotal);
    discount = toNumber(sale.invoice.discount);
    vatRate = toNumber(sale.invoice.vatRate);
    vatAmount = toNumber(sale.invoice.vatAmount);
    customerPhone = sale.invoice.customerPhone;
    customerEmail = sale.invoice.customerEmail;
    customerAddress = sale.invoice.customerAddress;
  } else {
    // Single sale item fallback
    const singleName = sale.description && sale.description.trim().length > 0
      ? sale.description.trim()
      : 'General Merchandise / Sales';
    const amountNum = toNumber(sale.amount);
    items = [
      {
        name: singleName,
        quantity: 1,
        unitPrice: amountNum,
        lineTotal: amountNum,
      },
    ];
    subtotal = amountNum;
  }

  const customerName = sale.customerName || sale.invoice?.customerName || null;
  const invoiceNumber = sale.source === 'invoice' ? (sale.referenceId || sale.invoice?.invoiceNumber || null) : null;

  const receiptData: import('./receipt.pdf').SalesReceiptData = {
    receiptNumber,
    transactionReference: sale.referenceId,
    transactionDate,
    amount: toNumber(sale.amount),
    source: sale.source as any,
    sourceLabel: sourceLabels[sale.source] || sale.source,
    customerName,
    customerPhone,
    customerEmail,
    customerAddress,
    description: sale.description,
    invoiceNumber,
    items,
    subtotal,
    discount,
    vatRate,
    vatAmount,
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
    newData: { receiptNumber, source: sale.source, itemCount: items.length },
  });

  logger.info('Sales receipt generated', { saleId, receiptNumber, source: sale.source, itemCount: items.length, businessId });

  return { buffer, filename, receiptNumber };
}
