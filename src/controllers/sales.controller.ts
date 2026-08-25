import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  createSaleSchema,
  updateSaleSchema,
  salesQuerySchema,
  salesSummaryQuerySchema,
  salesOverviewQuerySchema,
} from '@/validators/sales.validator';
import * as salesService from '@/services/sales.service';

export const getOverview = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = salesOverviewQuerySchema.parse(req.query);
  const overview = await salesService.getSalesAndExpensesOverview(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    data: overview,
  });
});


export const create = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = createSaleSchema.parse(req.body);
  
  // Admin test payments default to needsVerification: true
  if (req.user!.role === 'admin' && input.needsVerification === undefined) {
    input.needsVerification = true;
  }
  
  const sale = await salesService.createSale(
    req.user!.userId,
    req.params.businessId,
    input
  );

  res.status(201).json({
    success: true,
    data: sale,
    message: 'Sale recorded successfully',
  });
});

export const getAll = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = salesQuerySchema.parse(req.query);
  const result = await salesService.listSales(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const sale = await salesService.getSaleById(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: sale,
  });
});

export const update = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = updateSaleSchema.parse(req.body);
  const sale = await salesService.updateSale(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    input
  );

  res.status(200).json({
    success: true,
    data: sale,
    message: 'Sale updated successfully',
  });
});

export const remove = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await salesService.deleteSale(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'Sale deleted successfully',
  });
});

export const summary = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { month, year } = salesSummaryQuerySchema.parse(req.query);
  const result = await salesService.getMonthlySummary(
    req.user!.userId,
    req.params.businessId,
    month,
    year
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});


export const getUnverified = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = {
    page: req.query.page ? parseInt(req.query.page as string) : 1,
    limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
  };

  const result = await salesService.getUnverifiedSales(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const verify = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { classification = 'sale' } = req.body;

  const sale = await salesService.verifySale(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    classification
  );

  res.status(200).json({
    success: true,
    data: sale,
    message: 'Transaction verified successfully',
  });
});

export const reclassify = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { classification } = req.body;

  if (!classification || typeof classification !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Classification is required',
    });
  }

  const sale = await salesService.reclassifySale(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    classification
  );

  res.status(200).json({
    success: true,
    data: sale,
    message: 'Transaction reclassified successfully',
  });
});
