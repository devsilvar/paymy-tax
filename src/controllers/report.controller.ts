/**
 * Report Controller — validates query params and sends PDF buffer.
 * Follows the same pattern as statement.controller.ts.
 */
import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { reportPeriodSchema } from '@/validators/report.validator';
import * as reportService from '@/services/report.service';

export const downloadSalesReport = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { from, to } = reportPeriodSchema.parse(req.query);
  const { buffer, filename } = await reportService.getSalesReportPdf(
    req.user!.userId,
    req.params.businessId,
    from,
    to
  );

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });
  res.send(buffer);
});

export const downloadExpenseReport = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { from, to } = reportPeriodSchema.parse(req.query);
  const { buffer, filename } = await reportService.getExpenseReportPdf(
    req.user!.userId,
    req.params.businessId,
    from,
    to
  );

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });
  res.send(buffer);
});
