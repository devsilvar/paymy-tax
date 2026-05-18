import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';

interface AuditEntry {
  userId?: string;
  businessId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  oldData?: Record<string, any>;
  newData?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Write an audit log entry.
 *
 * When called with a transaction client (`tx`), the audit row is part
 * of that transaction — it commits or rolls back with everything else.
 *
 * When called WITHOUT `tx` (the default), it fires-and-forgets against
 * the global prisma client so it never blocks or crashes the caller.
 */
export function logAudit(entry: AuditEntry, tx?: TxClient): void {
  const db = tx ?? prisma;

  const promise = db.auditLog.create({
    data: {
      userId: entry.userId,
      businessId: entry.businessId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      oldData: entry.oldData ?? undefined,
      newData: entry.newData ?? undefined,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    },
  });

  // Inside a transaction the caller awaits the whole $transaction block,
  // so we don't need to handle the promise here — Prisma does.
  // Outside a transaction, swallow errors so the request isn't affected.
  if (!tx) {
    promise.catch((err) => {
      logger.error('Failed to write audit log', {
        error: err.message,
        entry,
      });
    });
  }
}
