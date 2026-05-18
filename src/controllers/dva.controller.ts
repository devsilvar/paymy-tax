import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as dvaService from '@/services/dva.service';

export const setupVirtualAccount = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await dvaService.setupVirtualAccount(
    req.user!.userId,
    req.params.businessId 
  );

  res.status(200).json({
    success: true,
    data: result,
    message: result.status === 'active'
      ? 'Virtual account created successfully'
      : 'Virtual account setup initiated',
  });
});

export const validateCustomer = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { bvn } = req.body;

  if (!bvn || typeof bvn !== 'string' || bvn.length !== 11 || !/^\d{11}$/.test(bvn)) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BVN', message: 'BVN must be exactly 11 digits' },
    });
    return;
  }

  const result = await dvaService.validateCustomer(
    req.user!.userId,
    req.params.businessId,
    bvn,
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'BVN validation submitted. This may take a few moments to process.',
  });
});

export const getVirtualAccount = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await dvaService.getVirtualAccount(
    req.user!.userId,
    req.params.businessId
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});
