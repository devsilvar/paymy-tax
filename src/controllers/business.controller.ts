import { Response } from 'express';
import { asyncHandler, AppError } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';

import {
  createBusinessSchema,
  updateBusinessSchema,
  businessQuerySchema,
} from '@/validators/business.validator';
import * as businessService from '@/services/business.service';

export const create = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = createBusinessSchema.parse(req.body);
  const business = await businessService.createBusiness(req.user!.userId, input);

  res.status(201).json({
    success: true,
    data: business,
    message: 'Business created successfully',
  });
});

export const getAll = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { page, limit } = businessQuerySchema.parse(req.query);
  const result = await businessService.listBusinesses(req.user!.userId, page, limit);

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const business = await businessService.getBusinessById(
    req.user!.userId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: business,
  });
});

export const update = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = updateBusinessSchema.parse(req.body);
  const business = await businessService.updateBusiness(
    req.user!.userId,
    req.params.id,
    input
  );

  res.status(200).json({
    success: true,
    data: business,
    message: 'Business updated successfully',
  });
});

export const remove = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await businessService.deleteBusiness(
    req.user!.userId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'Business deleted successfully',
  });
});

type MulterRequest = AuthenticatedRequest & {
  file?: { buffer: Buffer; mimetype: string; size: number; originalname: string };
};

export const uploadLogo = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const file = (req as MulterRequest).file;
  if (!file) {
    throw new AppError(400, 'No image file uploaded', 'LOGO_NO_FILE');
  }

  const business = await businessService.uploadLogo(
    req.user!.userId,
    req.params.id,
    file
  );

  res.status(200).json({
    success: true,
    data: business,
    message: 'Logo uploaded successfully',
  });
});

export const deleteLogo = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const business = await businessService.removeLogo(
    req.user!.userId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: business,
    message: 'Logo removed successfully',
  });
});

