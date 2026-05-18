import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  createSaleSchema,
  updateSaleSchema,
  salesQuerySchema,
  salesSummaryQuerySchema,
} from '@/validators/sales.validator';
import * as salesService from '@/services/sales.service';

export const create = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = createSaleSchema.parse(req.body);
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
