import { z } from 'zod';

export const calculateTaxSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
  taxRate: z.coerce.number().min(0).max(50).optional(), // override per-business if needed
});

export const taxReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded']).optional(),
});

export const dashboardQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

// ISO month `YYYY-MM`. We intentionally don't coerce through `Date` at the
// edge — downstream code builds the window explicitly to avoid TZ drift.
const isoMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be ISO month YYYY-MM');

export const taxAnalyticsQuerySchema = z.object({
  from: isoMonth.optional(),
  to: isoMonth.optional(),
  range: z.enum(['6m', '12m', '24m', 'all', 'custom']).optional(),
});

export type CalculateTaxInput = z.infer<typeof calculateTaxSchema>;
export type TaxReportsQueryInput = z.infer<typeof taxReportsQuerySchema>;
export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;
export type TaxAnalyticsQueryInput = z.infer<typeof taxAnalyticsQuerySchema>;
