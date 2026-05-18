import { z } from 'zod';

export const createSaleSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  source: z.enum(['bank_transfer', 'paycode', 'pos', 'online_store', 'manual']),
  status: z.enum(['confirmed', 'pending', 'reversed', 'disputed']).optional(),
  referenceId: z.string().max(200).trim().optional(),
  description: z.string().max(500).trim().optional(),
  customerName: z.string().max(200).trim().optional(),
  transactionDate: z.coerce.date(),
  metadata: z.any().optional(),
});

export const updateSaleSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0').optional(),
  source: z.enum(['bank_transfer', 'paycode', 'pos', 'online_store', 'manual']).optional(),
  status: z.enum(['confirmed', 'pending', 'reversed', 'disputed']).optional(),
  referenceId: z.string().max(200).trim().optional(),
  description: z.string().max(500).trim().optional(),
  customerName: z.string().max(200).trim().optional(),
  transactionDate: z.coerce.date().optional(),
  metadata: z.any().optional(),
});

export const salesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(['bank_transfer', 'paycode', 'pos', 'online_store', 'manual']).optional(),
  status: z.enum(['confirmed', 'pending', 'reversed', 'disputed']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

export const salesSummaryQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type UpdateSaleInput = z.infer<typeof updateSaleSchema>;
export type SalesQueryInput = z.infer<typeof salesQuerySchema>;
export type SalesSummaryQueryInput = z.infer<typeof salesSummaryQuerySchema>;
