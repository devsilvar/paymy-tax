import { z } from 'zod';

/**
 * Validates from/to date query parameters for sales and expense PDF reports.
 * Both are required and must be valid YYYY-MM-DD date strings.
 */
export const reportPeriodSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
}).refine(
  (data) => new Date(data.from) <= new Date(data.to),
  { message: '"from" date must not be after "to" date', path: ['from'] }
);

export type ReportPeriodInput = z.infer<typeof reportPeriodSchema>;
