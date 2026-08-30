import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as dvaService from '@/services/dva.service';
import * as settlementService from '@/services/settlement.service';
import {
  validateCustomerSchema,
  resolveSettlementSchema,
  connectSettlementSchema,
} from '@/validators/dva.validator';

export const setupVirtualAccount = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await dvaService.setupVirtualAccount(
    req.user!.userId,
    req.params.businessId 
  );

  res.status(200).json({
    success: true,
    data: result,
    message: result.status === 'active'
      ? 'Virtual account created successfully'
      : 'Virtual account setup initiated',
  });
});

export const validateCustomer = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  // Zod throws on parse fail — the global error handler maps ZodError to a
  // 400 with field-level details. Replaces the previous ad-hoc BVN-only
  // check and now enforces the bank-account shape Paystack requires.
  const input = validateCustomerSchema.parse(req.body);

  const result = await dvaService.validateCustomer(
    req.user!.userId,
    req.params.businessId,
    input,
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'BVN validation submitted. This may take a few moments to process.',
  });
});

export const getVirtualAccount = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await dvaService.getVirtualAccount(
    req.user!.userId,
    req.params.businessId
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});

export const getBalance = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await dvaService.getDVABalance(
    req.user!.userId,
    req.params.businessId
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});



export const requery = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await dvaService.requeryDVA(
    req.user!.userId,
    req.params.businessId
  );

  res.status(200).json({
    success: true,
    data: result,
    message: result.message,
  });
});



export const resolveSettlement = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { bankCode, accountNumber } = resolveSettlementSchema.parse(req.body);

  const result = await dvaService.resolveSettlementAccount(
    req.user!.userId,
    req.params.businessId,
    bankCode,
    accountNumber,
  );

  res.status(200).json({ success: true, data: result });
});

export const connectSettlement = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { bankCode, bankName, accountNumber, commissionPct, pin } = connectSettlementSchema.parse(req.body);

  // Consolidated: DVA settlement now uses the same guarded flow as the main settlement service
  const result = await settlementService.connectSettlementBank(req.user!.userId, req.params.businessId, {
    bankCode,
    bankName,
    accountNumber,
    commissionPct,
    pin,
  });

  res.status(200).json({ success: true, data: result });
});

export const getDVATransactions = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const result = await dvaService.getDVATransactions(req.user!.userId, req.params.businessId, {
    page,
    limit,
    status,
  });

  res.status(200).json({
    success: true,
    data: result.transactions,
    pagination: result.pagination,
  });
});