import { z } from 'zod';
import { asNumber } from './query.utils';

export const monthlyStatementSchema = z.object({
  month: asNumber({ min: 1, max: 12, int: true }),
  year: asNumber({ min: 2020, max: 2100, int: true }),
});

export const periodStatementSchema = z.object({
  startMonth: asNumber({ min: 1, max: 12, int: true }),
  startYear: asNumber({ min: 2020, max: 2100, int: true }),
  endMonth: asNumber({ min: 1, max: 12, int: true }),
  endYear: asNumber({ min: 2020, max: 2100, int: true }),
});

export type MonthlyStatementInput = z.infer<typeof monthlyStatementSchema>;
export type PeriodStatementInput = z.infer<typeof periodStatementSchema>;