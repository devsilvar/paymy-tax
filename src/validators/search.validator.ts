import { z } from 'zod';
import { asNumber } from './query.utils';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(100),
  // Per-section limit. Total result count = ~4 × limit.
  limit: asNumber({ min: 1, max: 10, int: true }).default(5),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;