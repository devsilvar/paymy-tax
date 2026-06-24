/**
 * DVA (Dedicated Virtual Account) validators.
 *
 * - `validateCustomerSchema`: BVN + bank-account validation submission.
 *   Paystack's current shape (`type: 'bank_account'`) requires all three of
 *   BVN, bank code, and account number — the old BVN-only shape was
 *   deprecated. See backend/src/lib/payment/paystack.provider.ts →
 *   `validateCustomer` for the upstream call.
 */
import { z } from 'zod';

/**
 * NUBAN account numbers are 10 digits. Paystack rejects anything else with
 * a 400 — we surface the same error client-side so the form blocks before
 * the network call. BVN is similarly 11 digits, NIBSS bank codes are 3
 * digits (e.g. "044" Access, "058" GTB).
 *
 * Bank code is constrained to 3 digits not because Paystack requires that
 * exact length forever, but because every NIBSS code in their list is
 * 3 digits today. If a 4-digit code ever shows up we'll see a 400 from
 * Paystack and can relax this then.
 */
export const validateCustomerSchema = z.object({
  bvn: z
    .string()
    .trim()
    .regex(/^\d{11}$/, 'BVN must be exactly 11 digits'),
  nin: z
    .string()
    .trim()
    .regex(/^\d{11}$/, 'NIN must be exactly 11 digits')
    .optional(),
  bankCode: z
    .string()
    .trim()
    .regex(/^\d{3,6}$/, 'Bank code must be a 3-6 digit NIBSS code'),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits (NUBAN)'),
});

export type ValidateCustomerInput = z.infer<typeof validateCustomerSchema>;

/**
 * Settlement bank connection (Option A subaccount split-settlement).
 *
 * `resolveSettlementSchema` is the name-enquiry preview (bank + account →
 * resolved account name). `connectSettlementSchema` commits it: it carries the
 * human-readable `bankName` for display (the resolved account name is fetched
 * server-side, never trusted from the client) and an optional platform
 * commission percentage (0–100). Mirrors the NUBAN/NIBSS shapes above.
 */
export const resolveSettlementSchema = z.object({
  bankCode: z
    .string()
    .trim()
    .regex(/^\d{3,6}$/, 'Bank code must be a 3-6 digit NIBSS code'),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits (NUBAN)'),
});

export const connectSettlementSchema = resolveSettlementSchema.extend({
  bankName: z.string().trim().min(1, 'Bank name is required'),
  commissionPct: z
    .number()
    .min(0, 'Commission cannot be negative')
    .max(100, 'Commission cannot exceed 100%')
    .optional(),
});

export type ResolveSettlementInput = z.infer<typeof resolveSettlementSchema>;
export type ConnectSettlementInput = z.infer<typeof connectSettlementSchema>;
