import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase().trim(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    ),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format')
    .optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    ),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase().trim(),
});

/**
 * Patch the authenticated user's profile. Currently scoped to `phone` only —
 * email lives in JWT claims and changing it would require a re-issue +
 * re-verification flow which we don't have. Wider profile edits live on the
 * Settings page already; this endpoint specifically exists so the Account
 * page can inline-capture phone before DVA setup (Paystack requires phone
 * for fintech customers).
 *
 * Phone is validated against E.164 (matches `registerSchema.phone`). The
 * service layer additionally enforces uniqueness via the DB constraint.
 */
export const updateMeSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format'),
  })
  .strict(); // Reject unknown keys — keeps the surface tight.

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    ),
});

export const updateBvnSchema = z.object({
  bvn: z
    .string()
    .trim()
    .regex(/^\d{11,12}$/, 'BVN must be 11 or 12 digits'),
  stepUpToken: z.string().min(1, 'Step-up token is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateBvnInput = z.infer<typeof updateBvnSchema>;

