import prisma, { TxClient } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import type { Business } from '@prisma/client';

interface CachedOwnership {
  business: Business;
  expiresAt: number;
}

const OWNERSHIP_TTL_MS = 60 * 1000; // 60 seconds TTL
const ownershipCache = new Map<string, CachedOwnership>();

function getCacheKey(userId: string, businessId: string): string {
  return `${userId}:${businessId}`;
}

/**
 * Invalidate cached business ownership (call on business update/delete/reconnect).
 * 
 * @param businessId - The business ID to invalidate
 * @param userId - Optional user ID. If provided, only invalidates that user's cache entry.
 *                 If omitted, invalidates all cache entries for this business.
 */
export function invalidateOwnershipCache(businessId: string, userId?: string): void {
  if (userId) {
    ownershipCache.delete(getCacheKey(userId, businessId));
  } else {
    // Invalidate all entries for this business across all users
    for (const [key] of ownershipCache.entries()) {
      if (key.endsWith(`:${businessId}`)) {
        ownershipCache.delete(key);
      }
    }
  }
}

/**
 * Verifies that a business exists and belongs to the authenticated user.
 * 
 * Uses a fast 60-second in-memory cache for standard queries to eliminate
 * redundant database hits. When called within a transaction context, bypasses
 * the cache to read fresh database state within the transaction's isolation level.
 * 
 * @param userId - The authenticated user's ID
 * @param businessId - The business ID to verify
 * @param tx - Optional transaction client. When provided, cache is bypassed.
 * @returns The verified Business object
 * @throws AppError 404 if business not found
 * @throws AppError 403 if business belongs to a different user
 */
export async function verifyBusinessOwnership(
  userId: string,
  businessId: string,
  tx?: TxClient
): Promise<Business> {
  const db = tx ?? prisma;

  // Transactions must read fresh DB state within their isolation level
  if (!tx) {
    const key = getCacheKey(userId, businessId);
    const cached = ownershipCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.business;
    }
  }

  const business = await db.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  // Cache warm result (only for non-transactional queries)
  if (!tx) {
    const key = getCacheKey(userId, businessId);
    ownershipCache.set(key, {
      business,
      expiresAt: Date.now() + OWNERSHIP_TTL_MS,
    });
  }

  return business;
}
