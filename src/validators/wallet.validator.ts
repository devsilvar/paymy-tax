import { z } from 'zod';

export const walletHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['credit', 'debit', 'payout', 'fee', 'reversal']).optional(),
  businessId: z.string().uuid('Invalid business ID format').optional(),
});

export type WalletHistoryQueryInput = z.infer<typeof walletHistoryQuerySchema>;
