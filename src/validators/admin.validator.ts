import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const userSearchSchema = paginationSchema.extend({
  search: z.string().optional(),
});

export const toggleStatusSchema = z.object({
  isActive: z.boolean(),
});

export const auditLogFilterSchema = paginationSchema.extend({
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type UserSearchInput = z.infer<typeof userSearchSchema>;
export type ToggleStatusInput = z.infer<typeof toggleStatusSchema>;
export type AuditLogFilterInput = z.infer<typeof auditLogFilterSchema>;
