/**
 * Bank list controller.
 *
 * Surfaces the cached Paystack bank list so the frontend BVN-validation
 * form can render a dropdown. Auth is required to match the rest of the
 * API — there's no PII here, but route-level auth simplifies rate-limit
 * accounting and audit attribution.
 */
import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as bankService from '@/services/bank.service';

export const listBanks = asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  // Country is hard-coded to "nigeria" — PayMyTax is a Nigeria-only product.
  // If we ever expand we'll lift this to a query param + Zod validator.
  const banks = await bankService.listBanks('nigeria');

  res.status(200).json({
    success: true,
    data: banks,
  });
});
