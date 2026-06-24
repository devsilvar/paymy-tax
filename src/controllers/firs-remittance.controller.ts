import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  createBatchSchema,
  recordRemittanceSchema,
  listRemittancesSchema,
} from '@/validators/firs-remittance.validator';
import * as remittanceService from '@/services/firs-remittance.service';

export const getSummary = asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const summary = await remittanceService.getCollectedSummary();

  res.status(200).json({ success: true, data: summary });
});

export const listRemittances = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { page, limit, status } = listRemittancesSchema.parse(req.query);
  const result = await remittanceService.listRemittances(page, limit, status);

  res.status(200).json({ success: true, ...result });
});

export const createBatch = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { paymentIds } = createBatchSchema.parse(req.body);
  const batch = await remittanceService.createRemittanceBatch(req.user!.userId, paymentIds);

  res.status(201).json({
    success: true,
    data: batch,
    message: 'Remittance batch created',
  });
});

export const getRemittance = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const batch = await remittanceService.getRemittance(req.params.id);

  res.status(200).json({ success: true, data: batch });
});

export const recordRemittance = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = recordRemittanceSchema.parse(req.body);
  const batch = await remittanceService.recordRemittance(req.user!.userId, req.params.id, input);

  res.status(200).json({
    success: true,
    data: batch,
    message: 'Remittance recorded',
  });
});
