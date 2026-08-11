import { z } from 'zod';
import { asNumber, asStringOptional } from './query.utils';

export const createSaleSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  source: z.enum(['bank_transfer', 'paycode', 'pos', 'online_store', 'manual', 'cash', 'invoice']),
  status: z.enum(['confirmed', 'pending', 'reversed', 'disputed']).optional(),
  referenceId: z.string().max(200).trim().optional(),
  description: z.string().max(500).trim().optional(),
  customerName: z.string().max(200).trim().optional(),
  transactionDate: z.coerce.date(),
  metadata: z.any().optional(),
  needsVerification: z.boolean().optional(),
});

export const updateSaleSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0').optional(),
  source: z.enum(['bank_transfer', 'paycode', 'pos', 'online_store', 'manual', 'cash', 'invoice']).optional(),
  status: z.enum(['confirmed', 'pending', 'reversed', 'disputed']).optional(),
  referenceId: z.string().max(200).trim().optional(),
  description: z.string().max(500).trim().optional(),
  customerName: z.string().max(200).trim().optional(),
  transactionDate: z.coerce.date().optional(),
  metadata: z.any().optional(),
});

export const salesQuerySchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
  source: z.enum(['bank_transfer', 'paycode', 'pos', 'online_store', 'manual', 'cash', 'invoice']).optional(),
  status: z.enum(['confirmed', 'pending', 'reversed', 'disputed']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  month: asNumber({ min: 1, max: 12, int: true }).optional(),
  year: asNumber({ min: 2020, max: 2100, int: true }).optional(),
});

export const salesSummaryQuerySchema = z.object({
  month: asNumber({ min: 1, max: 12, int: true }),
  year: asNumber({ min: 2020, max: 2100, int: true }),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type UpdateSaleInput = z.infer<typeof updateSaleSchema>;
export type SalesQueryInput = z.infer<typeof salesQuerySchema>;
export type SalesSummaryQueryInput = z.infer<typeof salesSummaryQuerySchema>;