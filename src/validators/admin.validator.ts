import { z } from 'zod';
import { asNumber, asStringOptional } from './query.utils';

export const paginationSchema = z.object({
  page: asNumber({ min: 1, int: true }).default(1),
  limit: asNumber({ min: 1, max: 100, int: true }).default(20),
});

export const userSearchSchema = paginationSchema.extend({
  search: asStringOptional,
});

export const toggleStatusSchema = z.object({
  isActive: z.boolean(),
});

export const verifyEmailSchema = z.object({
  isVerified: z.boolean(),
});

export const auditLogFilterSchema = paginationSchema.extend({
  userId: z.string().uuid().optional(),
  action: asStringOptional,
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type UserSearchInput = z.infer<typeof userSearchSchema>;
export type ToggleStatusInput = z.infer<typeof toggleStatusSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type AuditLogFilterInput = z.infer<typeof auditLogFilterSchema>;