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

export const manualSettleWithdrawalSchema = z.object({
  sessionReference: z.string().trim().min(3, 'Transfer reference or session ID is required'),
  notes: asStringOptional,
});

export const updateFeeConfigSchema = z.object({
  withdrawalFeePct: z.number().min(0, 'Fee percentage cannot be negative').max(10, 'Fee percentage cannot exceed 10%'),
  withdrawalFeeCap: z.number().min(0, 'Fee cap cannot be negative').max(100000, 'Fee cap cannot exceed ₦100,000'),
  minWithdrawalAmount: z.number().min(100, 'Minimum floor must be at least ₦100').max(1000000, 'Minimum floor cannot exceed ₦1,000,000'),
});

export const treasuryAnalyticsFilterSchema = paginationSchema.extend({
  type: z.enum(['all', 'inflow', 'outflow']).optional().default('all'),
  outcome: z.enum(['all', 'profit', 'loss']).optional().default('all'),
  search: asStringOptional,
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type UserSearchInput = z.infer<typeof userSearchSchema>;
export type ToggleStatusInput = z.infer<typeof toggleStatusSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type AuditLogFilterInput = z.infer<typeof auditLogFilterSchema>;
export type ManualSettleWithdrawalInput = z.infer<typeof manualSettleWithdrawalSchema>;
export type UpdateFeeConfigInput = z.infer<typeof updateFeeConfigSchema>;
export type TreasuryAnalyticsFilterInput = z.infer<typeof treasuryAnalyticsFilterSchema>;