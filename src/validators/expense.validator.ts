import { z } from 'zod';

const EXPENSE_CATEGORIES = [
  'rent', 'inventory', 'salary', 'utility', 'fuel', 'logistics', 'marketing', 'other',
] as const;

export const createExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1, 'Description is required').max(500).trim(),
  amount: z.number().positive('Amount must be greater than 0'),
  expenseDate: z.coerce.date(),
  receiptUrl: z.string().url('Must be a valid URL').max(1000).trim().optional(),
});

export const updateExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  description: z.string().min(1).max(500).trim().optional(),
  amount: z.number().positive('Amount must be greater than 0').optional(),
  expenseDate: z.coerce.date().optional(),
  receiptUrl: z.string().url('Must be a valid URL').max(1000).trim().nullable().optional(),
});

export const expenseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

export const expenseSummaryQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type ExpenseQueryInput = z.infer<typeof expenseQuerySchema>;
export type ExpenseSummaryQueryInput = z.infer<typeof expenseSummaryQuerySchema>;
