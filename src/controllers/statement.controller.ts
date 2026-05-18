import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { monthlyStatementSchema, periodStatementSchema } from '@/validators/statement.validator';
import * as statementService from '@/services/statement.service';

export const downloadMonthly = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { month, year } = monthlyStatementSchema.parse(req.query);
  const { buffer, filename } = await statementService.downloadMonthlyStatement(
    req.user!.userId,
    req.params.businessId,
    month,
    year
  );

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });
  res.send(buffer);
});

export const downloadPeriod = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { startMonth, startYear, endMonth, endYear } = periodStatementSchema.parse(req.query);
  const { buffer, filename } = await statementService.downloadPeriodStatement(
    req.user!.userId,
    req.params.businessId,
    startMonth,
    startYear,
    endMonth,
    endYear
  );

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });
  res.send(buffer);
});
