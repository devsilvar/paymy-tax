import { z } from 'zod';

export const monthlyStatementSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

export const periodStatementSchema = z.object({
  startMonth: z.coerce.number().int().min(1).max(12),
  startYear: z.coerce.number().int().min(2020).max(2100),
  endMonth: z.coerce.number().int().min(1).max(12),
  endYear: z.coerce.number().int().min(2020).max(2100),
});

export type MonthlyStatementInput = z.infer<typeof monthlyStatementSchema>;
export type PeriodStatementInput = z.infer<typeof periodStatementSchema>;
