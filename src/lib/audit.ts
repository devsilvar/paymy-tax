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
export async function logAudit(entry: AuditEntry, tx?: TxClient): Promise<void> {
  if (tx) {
    // Within an interactive transaction, explicitly await the database insert
    // so it forms part of the transaction's atomic promise resolution and avoids floating promises.
    await tx.auditLog.create({
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
  } else {
    // Outside a transaction, fire-and-forget against the global prisma client
    prisma.auditLog
      .create({
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
      })
      .catch((err) => {
        logger.error('Failed to write audit log', {
          error: err.message,
          entry,
        });
      });
  }
}
