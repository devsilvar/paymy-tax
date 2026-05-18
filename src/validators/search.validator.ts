import { z } from 'zod';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(100),
  // Per-section limit. Total result count = ~4 × limit.
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
