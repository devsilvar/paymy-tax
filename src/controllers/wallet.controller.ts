import { Response } from 'express';
import { AuthenticatedRequest } from '@/types';
import { WalletService } from '@/services/wallet.service';
import { walletHistoryQuerySchema } from '@/validators/wallet.validator';

/**
 * Fast O(1) balance read for the authenticated user's central wallet.
 */
export async function getWalletBalance(req: AuthenticatedRequest, res: Response) {
  const userId = req.user!.userId;
  const balance = await WalletService.getWalletBalance(userId);
  res.json({
    success: true,
    data: balance,
  });
}

/**
 * Returns paginated ledger history for the user's central wallet.
 */
export async function getWalletHistory(req: AuthenticatedRequest, res: Response) {
  const userId = req.user!.userId;
  const query = walletHistoryQuerySchema.parse(req.query);
  const result = await WalletService.getWalletHistory(userId, query);
  res.json({
    success: true,
    data: result.transactions,
    pagination: result.pagination,
  });
}
