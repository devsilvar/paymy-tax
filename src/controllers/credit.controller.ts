import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as creditService from '@/services/credit.service';
import {
  createCreditSchema,
  recordPaymentSchema,
  updateCreditSchema,
  writeOffCreditSchema,
  creditsQuerySchema,
  linkDvaSchema,
} from '@/validators/credit.validator';

export const create = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const data = createCreditSchema.parse(req.body);
  const result = await creditService.createCredit(req.user!.userId, req.params.businessId, data);
  res.status(201).json({ success: true, data: result, message: 'Credit created successfully' });
});

export const list = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = creditsQuerySchema.parse(req.query);
  const result = await creditService.listCredits(req.user!.userId, req.params.businessId, query);
  res.status(200).json({
    success: true,
    data: result.data,
    pagination: result.pagination,
    message: 'Credits fetched successfully',
  });
});

export const getSummary = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await creditService.getCreditsSummary(req.user!.userId, req.params.businessId);
  res.status(200).json({ success: true, data: result, message: 'Credit summary fetched successfully' });
});

export const getById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await creditService.getCreditById(req.user!.userId, req.params.businessId, req.params.creditId);
  res.status(200).json({ success: true, data: result, message: 'Credit fetched successfully' });
});

export const update = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const data = updateCreditSchema.parse(req.body);
  const result = await creditService.updateCredit(req.user!.userId, req.params.businessId, req.params.creditId, data);
  res.status(200).json({ success: true, data: result, message: 'Credit updated successfully' });
});

export const recordPayment = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const data = recordPaymentSchema.parse(req.body);
  const result = await creditService.recordPayment(req.user!.userId, req.params.businessId, req.params.creditId, data);
  res.status(200).json({ success: true, data: result, message: 'Payment recorded successfully' });
});

export const writeOff = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const data = writeOffCreditSchema.parse(req.body);
  const result = await creditService.writeOffCredit(req.user!.userId, req.params.businessId, req.params.creditId, data);
  res.status(200).json({ success: true, data: result, message: 'Credit written off successfully' });
});

export const linkDva = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await creditService.reconcileDvaTransferToCredit(
    req.user!.userId,
    req.params.businessId,
    req.params.creditId,
    req.params.saleId
  );
  res.status(200).json({ success: true, data: result, message: 'DVA transfer linked successfully' });
});

export const getWhatsAppLink = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await creditService.getWhatsAppReminderLink(req.user!.userId, req.params.businessId, req.params.creditId);
  res.status(200).json({
    success: true,
    data: result,
    meta: result,
    message: 'WhatsApp reminder link generated',
  });
});
