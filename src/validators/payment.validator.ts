import { z } from 'zod';

export const initiatePaymentSchema = z.object({
  taxReportId: z.string().uuid(),
  callbackUrl: z.string().url().optional(),
});

export const listPaymentsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded']).optional(),
});

export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;
export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;
