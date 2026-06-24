import { z } from 'zod';
import { asNumber } from './query.utils';

// Create a remittance batch. With no paymentIds, sweeps all collected payments.
export const createBatchSchema = z.object({
  paymentIds: z.array(z.string().uuid()).optional(),
});

// Record a manual FIRS remittance against an open batch.
export const recordRemittanceSchema = z.object({
  firsReference: z.string().trim().min(1, 'FIRS reference is required').max(200),
  firsReceiptUrl: z.string().url('Receipt URL must be a valid URL').optional(),
  note: z.string().max(500).optional(),
  transport: z.enum(['manual']).default('manual'),
});

export const listRemittancesSchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
  status: z.enum(['collected', 'remitting', 'remitted']).optional(),
});

export type CreateBatchInput = z.infer<typeof createBatchSchema>;
export type RecordRemittanceInput = z.infer<typeof recordRemittanceSchema>;
export type ListRemittancesInput = z.infer<typeof listRemittancesSchema>;
