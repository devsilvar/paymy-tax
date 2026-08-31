import { Response } from 'express';
import { AuthenticatedRequest } from '@/types';
import * as settlementService from '@/services/settlement.service';
import {
  withdrawBalanceSchema,
  toggleAutoSplitSchema,
  payoutHistoryQuerySchema,
  connectSettlementSchema,
  resolveSettlementSchema,
} from '@/validators/settlement.validator';

export async function getPayoutPreview(req: AuthenticatedRequest, res: Response) {
  const result = await settlementService.getPayoutPreview(
    req.user!.userId,
    req.params.businessId
  );
  res.json({ success: true, data: result });
}

export async function resolveAccount(req: AuthenticatedRequest, res: Response) {
  const input = resolveSettlementSchema.parse(req.body);
  const result = await settlementService.resolveSettlementAccount(input);
  res.json({ success: true, data: result });
}

export async function connectBank(req: AuthenticatedRequest, res: Response) {
  const input = connectSettlementSchema.parse(req.body);
  const result = await settlementService.connectSettlementBank(
    req.user!.userId,
    req.params.businessId,
    input
  );
  res.json({ success: true, data: result, message: 'Settlement bank connected successfully' });
}

export async function withdrawBalance(req: AuthenticatedRequest, res: Response) {
  const input = withdrawBalanceSchema.parse(req.body);
  const result = await settlementService.withdrawBalance(
    req.user!.userId,
    req.params.businessId,
    input
  );
  res.json({ success: true, data: result, message: 'Withdrawal request submitted (awaiting admin approval)' });
}

export async function toggleAutoSplit(req: AuthenticatedRequest, res: Response) {
  const input = toggleAutoSplitSchema.parse(req.body);
  const result = await settlementService.toggleAutoSplit(
    req.user!.userId,
    req.params.businessId,
    input
  );
  res.json({ success: true, data: result, message: 'Auto-split settings updated successfully' });
}

export async function listPayoutHistory(req: AuthenticatedRequest, res: Response) {
  const query = payoutHistoryQuerySchema.parse(req.query);
  const result = await settlementService.listPayoutHistory(
    req.user!.userId,
    req.params.businessId,
    query
  );
  res.json({ success: true, data: result.items, pagination: result.pagination });
}
