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

export const downloadLedger = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const scope = (req.query.scope as 'dva_bank' | 'all_income') || 'dva_bank';
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const { buffer, filename } = await statementService.getLedgerStatementPdf(
    req.user!.userId,
    req.params.businessId,
    { scope, from, to }
  );

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });
  res.send(buffer);
});

export const emailLedger = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const scope = (req.body.scope as 'dva_bank' | 'all_income') || 'dva_bank';
  const from = req.body.from as string | undefined;
  const to = req.body.to as string | undefined;
  const recipientEmail = req.body.recipientEmail as string;

  const result = await statementService.emailLedgerStatement(
    req.user!.userId,
    req.params.businessId,
    { scope, from, to, recipientEmail }
  );

  res.json({
    success: true,
    data: result,
    message: result.delivered
      ? `Statement emailed successfully to ${recipientEmail}`
      : `Statement generated (dev fallback logged)`,
  });
});
