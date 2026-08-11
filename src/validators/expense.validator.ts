import { z } from 'zod';
import { asNumber } from './query.utils';

const EXPENSE_CATEGORIES = [
  'rent', 'inventory', 'salary', 'utility', 'fuel', 'logistics', 'marketing', 'other',
] as const;

export const createExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1, 'Description is required').max(500).trim(),
  amount: z.number().positive('Amount must be greater than 0'),
  expenseDate: z.coerce.date(),
  receiptUrl: z.string().url('Must be a valid URL').max(1000).trim().optional(),
  isDeductible: z.boolean().optional().default(true),
});

export const updateExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  description: z.string().min(1).max(500).trim().optional(),
  amount: z.number().positive('Amount must be greater than 0').optional(),
  expenseDate: z.coerce.date().optional(),
  receiptUrl: z.string().url('Must be a valid URL').max(1000).trim().nullable().optional(),
  isDeductible: z.boolean().optional(),
});

export const expenseQuerySchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  month: asNumber({ min: 1, max: 12, int: true }).optional(),
  year: asNumber({ min: 2020, max: 2100, int: true }).optional(),
});

export const expenseSummaryQuerySchema = z.object({
  month: asNumber({ min: 1, max: 12, int: true }),
  year: asNumber({ min: 2020, max: 2100, int: true }),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type ExpenseQueryInput = z.infer<typeof expenseQuerySchema>;
export type ExpenseSummaryQueryInput = z.infer<typeof expenseSummaryQuerySchema>;