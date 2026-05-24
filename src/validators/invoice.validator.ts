import { z } from 'zod';
import { asNumber, asStringOptional } from './query.utils';

const invoiceLineSchema = z.object({
  description: z.string().min(1, 'Line description is required').max(500).trim(),
  quantity: z.number().positive('Quantity must be greater than 0'),
  unitPrice: z.number().nonnegative('Unit price cannot be negative'),
});

export const createInvoiceSchema = z
  .object({
    // Customer — inline fields only, no saved customer records
    customerName: z.string().min(1, 'Customer name is required').max(200).trim(),
    customerEmail: z.string().email().max(200).trim().optional().or(z.literal('')),
    customerPhone: z.string().max(30).trim().optional().or(z.literal('')),
    customerAddress: z.string().max(500).trim().optional().or(z.literal('')),
    customerTaxId: z.string().max(50).trim().optional().or(z.literal('')),

    // Dates
    issueDate: z.coerce.date(),
    dueDate: z.coerce.date(),

    // Money — VAT exclusive (shown separately per FIRS standard)
    vatRate: z.number().min(0).max(100).default(7.5),
    discount: z.number().nonnegative().default(0),
    currency: z.string().length(3).default('NGN'),

    // Optional metadata
    notes: z.string().max(2000).trim().optional().or(z.literal('')),
    paymentTerms: z.string().max(500).trim().optional().or(z.literal('')),

    // Line items
    lines: z.array(invoiceLineSchema).min(1, 'At least one line item is required'),
  })
  .refine((data) => data.dueDate >= data.issueDate, {
    message: 'Due date cannot be before issue date',
    path: ['dueDate'],
  });

export const updateInvoiceSchema = z
  .object({
    customerName: z.string().min(1).max(200).trim().optional(),
    customerEmail: z.string().email().max(200).trim().optional().or(z.literal('')),
    customerPhone: z.string().max(30).trim().optional().or(z.literal('')),
    customerAddress: z.string().max(500).trim().optional().or(z.literal('')),
    customerTaxId: z.string().max(50).trim().optional().or(z.literal('')),
    issueDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    vatRate: z.number().min(0).max(100).optional(),
    discount: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().max(2000).trim().optional().or(z.literal('')),
    paymentTerms: z.string().max(500).trim().optional().or(z.literal('')),
    lines: z.array(invoiceLineSchema).min(1, 'At least one line item is required').optional(),
  })
  .refine(
    (data) => {
      if (data.issueDate && data.dueDate) return data.dueDate >= data.issueDate;
      return true;
    },
    { message: 'Due date cannot be before issue date', path: ['dueDate'] },
  );

export const invoicePaymentMethodSchema = z.enum([
  'cash',
  'bank_transfer',
  'pos',
  'card',
  'mobile_money',
  'cheque',
  'online',
  'other',
]);

export const markInvoicePaidSchema = z.object({
  paymentMethod: invoicePaymentMethodSchema,
  paymentDate: z.coerce.date().optional(),
});

export const cancelInvoiceSchema = z.object({
  reason: z.string().max(500).trim().optional().or(z.literal('')),
});

export const invoicesQuerySchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).optional(),
  search: asStringOptional,
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type InvoicesQueryInput = z.infer<typeof invoicesQuerySchema>;
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;
export type MarkInvoicePaidInput = z.infer<typeof markInvoicePaidSchema>;
export type InvoicePaymentMethod = z.infer<typeof invoicePaymentMethodSchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;