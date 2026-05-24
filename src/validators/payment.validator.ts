import { z } from 'zod';
import { asNumber } from './query.utils';

export const initiatePaymentSchema = z.object({
  taxReportId: z.string().uuid(),
  callbackUrl: z.string().url().optional(),
});

export const listPaymentsSchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded']).optional(),
});

export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;
export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;