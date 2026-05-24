import { z } from 'zod';
import { asNumber } from './query.utils';

export const reminderQuerySchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
  status: z.enum(['pending', 'sent', 'all']).default('all'),
});

export const generateRemindersSchema = z.object({
  month: asNumber({ min: 1, max: 12, int: true }),
  year: asNumber({ min: 2020, max: 2100, int: true }),
});

export const dismissReminderSchema = z.object({
  dismissedAt: z.coerce.date().optional(),
});

export type ReminderQueryInput = z.infer<typeof reminderQuerySchema>;
export type GenerateRemindersInput = z.infer<typeof generateRemindersSchema>;