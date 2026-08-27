import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { ledgerQuerySchema } from '@/validators/ledger.validator';
import * as ledgerService from '@/services/ledger.service';

export const getLedger = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = ledgerQuerySchema.parse(req.query);
  const result = await ledgerService.getUnifiedLedger(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.json({
    success: true,
    data: result.data,
    summary: result.summary,
    pagination: result.pagination,
  });
});
