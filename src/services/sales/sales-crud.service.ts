import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { CreateSaleInput, UpdateSaleInput, SaleLineItemInput } from '@/validators/sales.validator';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { assertMonthNotLocked, resolveTransactionDateForLockedMonth } from '@/shared/helpers';

// ─── Helpers ────────────────────────────────────────────────

/**
 * Computes line totals and grand total for a basket of sale items.
 * Uses the same 2-decimal rounding as invoice computeTotals.
 */
export function computeSaleTotal(items: SaleLineItemInput[]): {
  total: number;
  lines: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    sortOrder: number;
  }>;
} {
  let total = 0;
  const lines = items.map((item, index) => {
    const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
    total = Math.round((total + lineTotal) * 100) / 100;
    return {
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal,
      sortOrder: index,
    };
  });
  return { total, lines };
}

// ─── CRUD ───────────────────────────────────────────────────

export async function createSale(
  userId: string,
  businessId: string,
  input: CreateSaleInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);
  const dateRes = await resolveTransactionDateForLockedMonth(businessId, input.transactionDate, db);
  if (dateRes.wasAdjusted) {
    logger.warn('Sale transactionDate adjusted from locked/finalized month to current active month', {
      businessId,
      originalDate: dateRes.originalDate?.toISOString(),
      effectiveDate: dateRes.effectiveDate.toISOString(),
      reason: dateRes.reason,
    });
  }

  const hasItems = input.items !== undefined && input.items.length > 0;
  const { total: computedTotal, lines } = hasItems
    ? computeSaleTotal(input.items!)
    : { total: 0, lines: [] };
  const effectiveAmount = hasItems ? computedTotal : input.amount!;

  let description = input.description;
  if (!description && hasItems) {
    const itemSummary = input.items!.map((i) => `${i.name} (${i.quantity})`).join(', ');
    description = `${input.items!.length} item${input.items!.length > 1 ? 's' : ''}: ${itemSummary}`.slice(0, 500);
  }

  const runCreate = async (client: TxClient | typeof prisma) => {
    const sale = await client.salesTransaction.create({
      data: {
        businessId,
        amount: effectiveAmount,
        source: input.source,
        // Canonical settled status — matches the tax engine, verification, and
        // the DB reality (all settled rows are 'confirmed').
        status: input.status ?? 'confirmed',
        referenceId: input.referenceId,
        description,
        customerName: input.customerName,
        transactionDate: dateRes.effectiveDate,
        metadata: {
          ...(input.metadata !== undefined && typeof input.metadata === 'object' ? input.metadata : {}),
          ...(dateRes.wasAdjusted
            ? {
                dateAdjustedFromLockedMonth: true,
                originalTransactionDate: dateRes.originalDate?.toISOString(),
                adjustmentReason: dateRes.reason,
              }
            : {}),
        },
        needsVerification: input.needsVerification ?? false,
        createdBy: userId,
        ...(hasItems
          ? {
              items: {
                createMany: {
                  data: lines,
                },
              },
            }
          : {}),
      },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    await logAudit(
      {
        userId,
        businessId,
        action: 'sale.created',
        resourceType: 'sales_transaction',
        resourceId: sale.id,
        newData: {
          amount: effectiveAmount,
          source: input.source,
          transactionDate: dateRes.effectiveDate.toISOString(),
          ...(dateRes.wasAdjusted
            ? {
                dateAdjustedFromLockedMonth: true,
                originalTransactionDate: dateRes.originalDate?.toISOString(),
              }
            : {}),
          ...(hasItems ? { itemCount: lines.length } : {}),
        },
      },
      tx ? (client as TxClient) : undefined
    );

    return sale;
  };


  const sale = tx
    ? await runCreate(tx)
    : hasItems
    ? await prisma.$transaction((innerTx) => runCreate(innerTx))
    : await runCreate(prisma);

  logger.info('Sale created', { saleId: sale.id, businessId, userId });

  return sale;
}

export async function listSales(
  userId: string,
  businessId: string,
  query: {
    page: number;
    limit: number;
    source?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    month?: number;
    year?: number;
  }
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };

  if (query.source) where.source = query.source;
  if (query.status) where.status = query.status;

  // Date range filter
  if (query.startDate || query.endDate) {
    where.transactionDate = {};
    if (query.startDate) where.transactionDate.gte = query.startDate;
    if (query.endDate) where.transactionDate.lte = query.endDate;
  }

  // Month/year filter — takes precedence over date range
  if (query.month && query.year) {
    const monthStart = new Date(query.year, query.month - 1, 1);
    const monthEnd = new Date(query.year, query.month, 0); // last day of month
    where.transactionDate = { gte: monthStart, lte: monthEnd };
  }

  const offset = (query.page - 1) * query.limit;

  const [sales, total] = await Promise.all([
    prisma.salesTransaction.findMany({
      where,
      skip: offset,
      take: query.limit,
      // Secondary sort by createdAt so bulk imports sharing a transactionDate
      // surface newest-first instead of in arbitrary Postgres order.
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        _count: {
          select: { items: true },
        },
      },
    }),
    prisma.salesTransaction.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: sales.map((sale) => ({
      ...sale,
      itemsCount: sale._count.items,
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: query.page < totalPages,
      hasPrev: query.page > 1,
    },
  };
}

export async function getSaleById(userId: string, businessId: string, saleId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const sale = await prisma.salesTransaction.findUnique({
    where: { id: saleId },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!sale || sale.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  return sale;
}

export async function updateSale(
  userId: string,
  businessId: string,
  saleId: string,
  input: UpdateSaleInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const existing = await db.salesTransaction.findUnique({
    where: { id: saleId },
    include: { items: true },
  });

  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  // Check lock on the EXISTING transaction date (can't edit a sale in a locked month)
  await assertMonthNotLocked(businessId, existing.transactionDate, db);

  // If the transaction date is changing, also check the NEW month isn't locked
  if (input.transactionDate && input.transactionDate.getTime() !== existing.transactionDate.getTime()) {
    await assertMonthNotLocked(businessId, input.transactionDate, db);
  }

  const runUpdate = async (client: TxClient | typeof prisma) => {
    const data: Record<string, any> = {};
    if (input.source !== undefined) data.source = input.source;
    if (input.status !== undefined) data.status = input.status;
    if (input.referenceId !== undefined) data.referenceId = input.referenceId;
    if (input.description !== undefined) data.description = input.description;
    if (input.customerName !== undefined) data.customerName = input.customerName;
    if (input.transactionDate !== undefined) data.transactionDate = input.transactionDate;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    let itemCount: number | undefined;

    if (input.items !== undefined) {
      if (input.items.length > 0) {
        const { total: computedTotal, lines } = computeSaleTotal(input.items);
        data.amount = computedTotal;
        itemCount = lines.length;

        // Atomically replace all lines
        await client.saleLineItem.deleteMany({ where: { saleId } });
        await client.saleLineItem.createMany({
          data: lines.map((line) => ({ ...line, saleId })),
        });
      } else {
        // items: [] -> basket converted to single amount
        await client.saleLineItem.deleteMany({ where: { saleId } });
        if (input.amount !== undefined) {
          data.amount = input.amount;
        }
        itemCount = 0;
      }
    } else if (input.amount !== undefined) {
      data.amount = input.amount;
    }

    const updated = await client.salesTransaction.update({
      where: { id: saleId },
      data,
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    logAudit(
      {
        userId,
        businessId,
        action: 'sale.updated',
        resourceType: 'sales_transaction',
        resourceId: saleId,
        oldData: { amount: Number(existing.amount), source: existing.source },
        newData: {
          ...input,
          ...(itemCount !== undefined ? { itemCount } : {}),
          ...(data.amount !== undefined ? { amount: data.amount } : {}),
        } as Record<string, any>,
      },
      tx ? (client as TxClient) : undefined
    );

    return updated;
  };

  const updated = tx
    ? await runUpdate(tx)
    : await prisma.$transaction((innerTx) => runUpdate(innerTx));

  logger.info('Sale updated', { saleId, businessId, userId });

  return updated;
}

export async function deleteSale(
  userId: string,
  businessId: string,
  saleId: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const existing = await db.salesTransaction.findUnique({ where: { id: saleId } });

  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  await assertMonthNotLocked(businessId, existing.transactionDate, db);

  await db.salesTransaction.delete({
    where: { id: saleId },
  });

  await logAudit({
    userId,
    businessId,
    action: 'sale.deleted',
    resourceType: 'sales_transaction',
    resourceId: saleId,
    oldData: { amount: Number(existing.amount), source: existing.source, description: existing.description },
  }, tx);

  logger.info('Sale deleted', { saleId, businessId, userId });

  return { message: 'Sale deleted successfully' };
}
