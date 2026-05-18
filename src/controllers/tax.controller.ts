import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  calculateTaxSchema,
  taxReportsQuerySchema,
  dashboardQuerySchema,
  taxAnalyticsQuerySchema,
} from '@/validators/tax.validator';
import * as taxService from '@/services/tax.service';

export const calculate = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { month, year, taxRate } = calculateTaxSchema.parse(req.body);
  const { warnings, ...report } = await taxService.calculateTax(
    req.user!.userId,
    req.params.businessId,
    month,
    year,
    taxRate
  );

  res.status(200).json({
    success: true,
    data: report,
    warnings,
    message: 'Tax calculated successfully',
  });
});

export const listReports = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = taxReportsQuerySchema.parse(req.query);
  const result = await taxService.listReports(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getReport = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const report = await taxService.getReportById(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: report,
  });
});

export const finalize = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const report = await taxService.finalizeReport(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: report,
    message: 'Report finalized successfully',
  });
});

export const unfinalize = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const report = await taxService.unfinalizeReport(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: report,
    message: 'Report un-finalized successfully',
  });
});

export const dashboard = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { months } = dashboardQuerySchema.parse(req.query);
  const result = await taxService.getDashboard(
    req.user!.userId,
    req.params.businessId,
    months
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});

export const analytics = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = taxAnalyticsQuerySchema.parse(req.query);
  const result = await taxService.getTaxAnalytics(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});
