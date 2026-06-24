import { z } from 'zod';

// Transform query params from string | string[] to single values
const queryNumber = (opts?: { min?: number; max?: number; int?: boolean }) =>
  z.preprocess(
    (val) => {
      if (val === undefined) return undefined;
      if (Array.isArray(val)) return val[0];
      return val;
    },
    opts?.int
      ? z.coerce.number().int().min(opts.min ?? 0).max(opts.max ?? Number.MAX_SAFE_INTEGER)
      : z.coerce.number().min(opts?.min ?? 0).max(opts?.max ?? Number.MAX_SAFE_INTEGER)
  );

const queryString = z.preprocess(
  (val) => {
    if (val === undefined) return undefined;
    if (Array.isArray(val)) return val[0];
    return val;
  },
  z.string()
);

const queryOptionalString = z.preprocess(
  (val) => {
    if (val === undefined) return undefined;
    if (Array.isArray(val)) return val[0];
    return val;
  },
  z.string().optional()
);

export const calculateTaxSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
  taxRate: z.coerce.number().min(0).max(50).optional(), // override per-business if needed
});

export const taxReportsQuerySchema = z.object({
  page: queryNumber({ min: 1 }).default(1),
  limit: queryNumber({ min: 1, max: 100 }).default(12),
  year: queryNumber({ min: 2020, max: 2100 }).optional(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded']).optional(),
});

export const dashboardQuerySchema = z.object({
  months: queryNumber({ min: 1, max: 24 }).default(6),
});

// ISO month `YYYY-MM`. We intentionally don't coerce through `Date` at the
// edge — downstream code builds the window explicitly to avoid TZ drift.
const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be ISO month YYYY-MM');

// Apply the isoMonth regex to from/to so garbage input returns a structured
// 400 at the validator boundary rather than falling through to the service,
// where `parseMonthKey` would produce an Invalid Date and Prisma would crash
// the request with a 500.
const queryIsoMonth = z.preprocess(
  (val) => {
    if (val === undefined) return undefined;
    if (Array.isArray(val)) return val[0];
    return val;
  },
  isoMonth.optional()
);

export const taxAnalyticsQuerySchema = z.object({
  from: queryIsoMonth,
  to: queryIsoMonth,
  range: z.enum(['6m', '12m', '24m', 'all', 'custom']).optional(),
});

export type CalculateTaxInput = z.infer<typeof calculateTaxSchema>;
export type TaxReportsQueryInput = z.infer<typeof taxReportsQuerySchema>;
export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;
export type TaxAnalyticsQueryInput = z.infer<typeof taxAnalyticsQuerySchema>;