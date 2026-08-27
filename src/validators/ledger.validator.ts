import { z } from 'zod';

export const ledgerQuerySchema = z.object({
  scope: z.enum(['dva_bank', 'all_income']).default('dva_bank'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format must be YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format must be YYYY-MM-DD')
    .optional(),
  type: z.enum(['all', 'credit', 'debit']).default('all'),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type LedgerQueryInput = z.infer<typeof ledgerQuerySchema>;
