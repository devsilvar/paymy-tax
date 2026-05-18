import { z } from 'zod';

export const reminderQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'sent', 'all']).default('all'),
});

export const generateRemindersSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

export const dismissReminderSchema = z.object({
  dismissedAt: z.coerce.date().optional(),
});

export type ReminderQueryInput = z.infer<typeof reminderQuerySchema>;
export type GenerateRemindersInput = z.infer<typeof generateRemindersSchema>;
