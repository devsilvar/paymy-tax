import { z } from 'zod';

const asNumber = z.coerce.number().int().positive();
const asStringOptional = z.string().optional();

export const creditLineItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').max(200),
  quantity: z.number().positive('Quantity must be greater than 0').max(100_000),
  unitPrice: z.number().nonnegative('Unit price must be non-negative').max(1e13),
});

export const createCreditSchema = z
  .object({
    customerName: z.string().min(2, 'Customer name is required').max(200).trim(),
    customerEmail: z.string().email().max(200).trim().optional().or(z.literal('')),
    customerPhone: z.string().max(30).trim().optional().or(z.literal('')),
    description: z.string().min(3, 'Description must be at least 3 characters').max(500).trim().optional().or(z.literal('')),
    totalAmount: z.number().positive('Amount must be greater than 0').min(100, 'Minimum credit amount is \u20a6100').optional(),
    items: z.array(creditLineItemSchema).max(50).optional(),
    issueDate: z.coerce.date(),
    dueDate: z.coerce.date(),
    reminderDate: z.coerce.date().optional(),
    customerId: z.string().uuid().optional(),
    guarantorName: z.string().max(200).trim().optional().or(z.literal('')),
    guarantorPhone: z.string().max(30).trim().optional().or(z.literal('')),
    notes: z.string().max(2000).trim().optional().or(z.literal('')),
  })
  .refine((d) => d.dueDate >= d.issueDate, {
    message: 'Due date cannot be before issue date',
    path: ['dueDate'],
  })
  .refine((d) => !d.reminderDate || d.reminderDate <= d.dueDate, {
    message: 'Reminder date cannot be after due date',
    path: ['reminderDate'],
  })
  .superRefine((data, ctx) => {
    const hasItems = data.items !== undefined && data.items.length > 0;
    if (!hasItems && data.totalAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either items or totalAmount must be provided',
        path: ['totalAmount'],
      });
    }
    if (!hasItems && (!data.description || data.description.trim().length < 3)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Description is required when items are not provided',
        path: ['description'],
      });
    }
  });

export const recordPaymentSchema = z.object({
  amount: z.number().positive('Payment amount must be greater than 0'),
  paymentDate: z.coerce.date(),
  paymentType: z.enum(['cash', 'bank_transfer', 'pos', 'manual', 'online_store', 'paycode']),
  notes: z.string().max(2000).trim().optional().or(z.literal('')),
});

export const updateCreditSchema = z
  .object({
    customerName: z.string().min(2).max(200).trim().optional(),
    customerPhone: z.string().max(30).trim().optional().or(z.literal('')),
    customerEmail: z.string().email().max(200).trim().optional().or(z.literal('')),
    description: z.string().min(3).max(500).trim().optional(),
    dueDate: z.coerce.date().optional(),
    reminderDate: z.coerce.date().optional(),
    notes: z.string().max(2000).trim().optional().or(z.literal('')),
    guarantorName: z.string().max(200).trim().optional().or(z.literal('')),
    guarantorPhone: z.string().max(30).trim().optional().or(z.literal('')),
  })
  .refine(
    (d) => {
      // Can't validate dueDate vs issueDate here since issueDate isn't in the update schema
      // That guard lives in the service layer
      return true;
    },
    { message: 'Invalid data' },
  );

export const writeOffCreditSchema = z.object({
  reason: z.string().min(5, 'Write-off reason must be at least 5 characters').max(1000).trim(),
});

export const creditsQuerySchema = z.object({
  page: asNumber.default(1),
  limit: asNumber.default(20),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'written_off', 'overdue']).optional(),
  search: asStringOptional,
});

export const linkDvaSchema = z.object({
  // No body needed — creditId and saleId come from URL params
});

export type CreditLineItemInput = z.infer<typeof creditLineItemSchema>;
export type CreateCreditInput = z.infer<typeof createCreditSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type UpdateCreditInput = z.infer<typeof updateCreditSchema>;
export type WriteOffCreditInput = z.infer<typeof writeOffCreditSchema>;
export type CreditsQueryInput = z.infer<typeof creditsQuerySchema>;
