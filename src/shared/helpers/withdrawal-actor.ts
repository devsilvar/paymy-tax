import prisma, { TxClient } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

/**
 * Retrieves the business and user security/settlement context for money-movement operations.
 *
 * CRITICAL SECURITY INVARIANT:
 * This helper is NEVER cached. Unlike standard business ownership queries (which cache for 60s
 * via lib/ownership.ts), withdrawal, payout, and bank-linking operations must evaluate live
 * database state — specifically `pinLockedUntil`, `pinAttempts`, and commercial settlement
 * account details.
 *
 * It accepts an optional transaction client (`tx`) to ensure that approval-time affordability
 * checks and debit operations execute strictly inside the caller's transaction isolation level.
 */
export async function getWithdrawalActor(
  userId: string,
  businessId: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;
  const business = await db.business.findFirst({
    where: { id: businessId, userId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          transactionPin: true,
          pinLockedUntil: true,
          pinAttempts: true,
          settlementBankCode: true,
          settlementBankName: true,
          settlementAccountNumber: true,
          settlementAccountName: true,
          settlementConnectedAt: true,
          virtualAccountNumber: true,
          virtualAccountBank: true,
          paystackCustomerCode: true,
          primaryBusinessId: true,
        },
      },
    },
  });

  if (!business) {
    throw new AppError(404, 'Business not found or access denied', 'BUSINESS_NOT_FOUND');
  }

  return business;
}

export type WithdrawalActor = Awaited<ReturnType<typeof getWithdrawalActor>>;
