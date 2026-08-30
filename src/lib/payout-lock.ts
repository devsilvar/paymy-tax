import { AppError } from '@/middleware/errorHandler';
import { Business } from '@prisma/client';

/**
 * Enforces payout account change lock with admin-granted one-time permissions.
 * 
 * Rules:
 * - First connect (no existing account): always allowed
 * - Change existing account: requires an un-consumed admin permission that hasn't expired
 * - Permission expires 24 hours after grant
 * - Permission is consumed atomically on successful change (handled by caller)
 * 
 * @param business - Business entity with payout lock fields
 * @throws {AppError} 403 PAYOUT_CHANGE_LOCKED if account is locked
 * @throws {AppError} 403 PAYOUT_PERMISSION_EXPIRED if permission expired
 */
export function assertPayoutChangeAllowed(business: Business): void {
  // First connect — no existing account to protect
  if (!business.settlementAccountNumber) {
    return;
  }

  // Check if permission granted
  if (!business.payoutChangePermitted) {
    throw new AppError(
      403,
      'Your payout account is locked for security. Contact support to request a change.',
      'PAYOUT_CHANGE_LOCKED',
    );
  }

  // Check if permission expired (24 hours from grant time)
  if (business.payoutChangePermittedAt) {
    const expiryTime = new Date(business.payoutChangePermittedAt);
    expiryTime.setHours(expiryTime.getHours() + 24);
    
    if (new Date() > expiryTime) {
      throw new AppError(
        403,
        'Your payout change permission expired. Please contact support to request a new one.',
        'PAYOUT_PERMISSION_EXPIRED',
      );
    }
  }

  // Permission is valid and un-expired — allow the change
  // Caller must consume it atomically in the DB update
}

/**
 * Computes derived payout lock state for API responses.
 * 
 * @param business - Business entity with payout lock fields
 * @returns Computed lock status with expiry time
 */
export function getPayoutLockStatus(business: Business) {
  const hasAccount = Boolean(business.settlementAccountNumber);
  const permitted = business.payoutChangePermitted;
  const permittedAt = business.payoutChangePermittedAt;
  const usedAt = business.payoutChangeUsedAt;

  let expiresAt: Date | null = null;
  let expired = false;

  if (permitted && permittedAt) {
    expiresAt = new Date(permittedAt);
    expiresAt.setHours(expiresAt.getHours() + 24);
    expired = new Date() > expiresAt;
  }

  return {
    locked: hasAccount && (!permitted || expired),
    permitted: permitted && !expired,
    permittedAt,
    usedAt,
    expiresAt,
  };
}
