import { z } from 'zod';

export const resolveSettlementSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
  bankCode: z.string().trim().min(1, 'Bank code is required'),
});

export const connectSettlementSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
  bankCode: z.string().trim().min(1, 'Bank code is required'),
  bankName: z.string().trim().min(1, 'Bank name is required'),
  commissionPct: z.number().min(0).max(100).optional().default(0),
});

export const withdrawBalanceSchema = z.object({
  amount: z
    .number()
    .positive('Withdrawal amount must be greater than zero')
    .min(100, 'Minimum withdrawal amount is ₦100.00'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'Transaction PIN must be exactly 4 digits'),
  narration: z.string().trim().max(100, 'Narration cannot exceed 100 characters').optional(),
});

export const toggleAutoSplitSchema = z.object({
  enabled: z.boolean(),
  taxSplitPercentage: z.number().min(0).max(100).optional().default(7.5),
});

export const payoutHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(['pending', 'completed', 'failed']).optional(),
});

export type ResolveSettlementInput = z.infer<typeof resolveSettlementSchema>;
export type ConnectSettlementInput = z.infer<typeof connectSettlementSchema>;
export type WithdrawBalanceInput = z.infer<typeof withdrawBalanceSchema>;
export type ToggleAutoSplitInput = z.infer<typeof toggleAutoSplitSchema>;
export type PayoutHistoryQueryInput = z.infer<typeof payoutHistoryQuerySchema>;
