import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { assertMonthNotLocked, toNumber } from '@/shared/helpers';

// ─── Verification ───────────────────────────────────────────

export async function getUnverifiedSales(
  userId: string,
  businessId: string,
  query?: { page?: number; limit?: number }
) {
  await verifyBusinessOwnership(userId, businessId);

  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  const offset = (page - 1) * limit;

  const [sales, total] = await Promise.all([
    prisma.salesTransaction.findMany({
      where: { businessId, needsVerification: true },
      skip: offset,
      take: limit,
      orderBy: { transactionDate: 'desc' },
    }),
    prisma.salesTransaction.count({
      where: { businessId, needsVerification: true },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: sales,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

// Legacy identifiers that older clients / scripts still send. They are not
// real classification names — map them to the canonical seeded names so old
// callers don't get INVALID_CLASSIFICATION. The canonical DB name always wins.
const LEGACY_CLASSIFICATION_ALIASES: Record<string, string> = {
  sale: 'Product Sale',
  sales_revenue: 'Product Sale',
  service_revenue: 'Service Revenue',
  business_income: 'Product Sale',
  transfer: 'Transfer Between Accounts',
  transfer_between_accounts: 'Transfer Between Accounts',
  loan: 'Loan Received',
  gift: 'Gift Received',
  grant: 'Grant Received',
  capital: 'Capital Injection',
  capital_injection: 'Capital Injection',
  other: 'Other',
};

function slugifyClassification(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export async function verifySale(
  userId: string,
  businessId: string,
  saleId: string,
  classificationName: string,
  tx?: TxClient,
  meta?: { customerName?: string; description?: string; targetBusinessId?: string }
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const sale = await db.salesTransaction.findUnique({ where: { id: saleId } });

  if (!sale) {
    throw new AppError(404, 'Sale not found', 'SALE_NOT_FOUND');
  }

  // If sale belongs to another business owned by the same user, verify ownership of that business
  if (sale.businessId !== businessId) {
    await verifyBusinessOwnership(userId, sale.businessId, db);
  }

  if (!sale.needsVerification) {
    // Idempotent: already verified
    return sale;
  }

  // Handle business reassignment if specified
  let targetBusinessId: string | undefined = undefined;
  if (meta?.targetBusinessId && meta.targetBusinessId !== businessId) {
    await verifyBusinessOwnership(userId, meta.targetBusinessId, db);
    await assertMonthNotLocked(businessId, sale.transactionDate, db);
    await assertMonthNotLocked(meta.targetBusinessId, sale.transactionDate, db);

    if (sale.referenceId) {
      const existingRef = await db.salesTransaction.findFirst({
        where: {
          businessId: meta.targetBusinessId,
          source: sale.source,
          referenceId: sale.referenceId,
        },
        select: { id: true },
      });

      if (existingRef) {
        throw new AppError(
          409,
          `Target business already has a transaction with reference ${sale.referenceId}`,
          'DUPLICATE_SALES_REFERENCE'
        );
      }
    }
    targetBusinessId = meta.targetBusinessId;
  }

  // Resolve the classification. Accepts, in order of precedence:
  //   1. Exact / case-insensitive display name ("Product Sale")
  //   2. Legacy alias slug ("sales_revenue", "sale", "service_revenue")
  //   3. Slugified display name ("product_sale" → "Product Sale")
  // The canonical DB name is what gets persisted to finalClassification.
  let classification =
    (await db.transactionClassification.findFirst({
      where: {
        OR: [
          { name: classificationName },
          { name: { equals: classificationName, mode: 'insensitive' } },
        ],
        isActive: true,
      },
    })) ??
    (await (async () => {
      const aliased = LEGACY_CLASSIFICATION_ALIASES[classificationName.trim().toLowerCase()];
      if (!aliased) return null;
      return db.transactionClassification.findFirst({
        where: { name: aliased, isActive: true },
      });
    })()) ??
    (await (async () => {
      const slug = slugifyClassification(classificationName);
      if (!slug) return null;
      const active = await db.transactionClassification.findMany({
        where: { isActive: true },
      });
      return active.find((c) => slugifyClassification(c.name) === slug) ?? null;
    })());

  if (!classification) {
    throw new AppError(400, `Classification "${classificationName}" not found`, 'INVALID_CLASSIFICATION');
  }

  // Determine if taxable based on classification
  const isTaxable = classification.taxTreatment === 'taxable';
  const isRevenue = classification.isRevenue;

  const updated = await db.salesTransaction.update({
    where: { id: saleId },
    data: {
      needsVerification: false,
      verifiedAt: new Date(),
      verifiedBy: userId,
      finalClassification: classification.name,
      classificationId: classification.id,
      status: 'confirmed', // Always confirm when verified
      isTaxable,
      ...(targetBusinessId ? { businessId: targetBusinessId } : {}),
      ...(meta?.customerName !== undefined && meta.customerName !== ''
        ? { customerName: meta.customerName }
        : {}),
      ...(meta?.description !== undefined && meta.description !== ''
        ? { description: meta.description }
        : {}),
    },
  });

  if (targetBusinessId) {
    await db.walletTransaction.updateMany({
      where: { linkedSaleId: saleId },
      data: { businessId: targetBusinessId },
    });
  }

  await logAudit({
    userId,
    businessId: targetBusinessId || businessId,
    action: isRevenue ? 'sale.verified' : 'sale.reclassified',
    resourceType: 'sales_transaction',
    resourceId: saleId,
    newData: {
      classification: classification.name,
      category: classification.category,
      isTaxable,
      isRevenue,
      ...(targetBusinessId ? { reassignedFromBusinessId: businessId } : {}),
    },
  }, tx);

  logger.info('Transaction classified', {
    saleId,
    businessId: targetBusinessId || businessId,
    originalBusinessId: businessId,
    userId,
    classification: classification.name,
    category: classification.category,
    isTaxable,
    isRevenue,
  });

  return updated;
}

export async function reclassifySale(
  userId: string,
  businessId: string,
  saleId: string,
  classificationName: string,
  tx?: TxClient,
  meta?: { targetBusinessId?: string }
) {
  // Reclassify is now an alias to verify with any classification
  return verifySale(userId, businessId, saleId, classificationName, tx, meta);
}

/**
 * Reassigns a sales transaction from one business to another.
 *
 * Requirements & Guards:
 * 1. The user must own both the source business and the target business.
 * 2. Neither business's month containing transactionDate may be locked/finalized.
 * 3. The target business cannot already have a transaction with the same (source, referenceId).
 * 4. Must be executed atomically in a transaction with audit logging.
 */
export async function reassignSaleBusiness(
  userId: string,
  sourceBusinessId: string,
  saleId: string,
  targetBusinessId: string
) {
  if (sourceBusinessId === targetBusinessId) {
    throw new AppError(400, 'Target business must be different from source business', 'INVALID_TARGET_BUSINESS');
  }

  // 1. Verify ownership of both businesses
  const [sourceBusiness, targetBusiness] = await Promise.all([
    verifyBusinessOwnership(userId, sourceBusinessId),
    verifyBusinessOwnership(userId, targetBusinessId),
  ]);

  // 2. Fetch sale and verify it belongs to source business
  const sale = await prisma.salesTransaction.findUnique({
    where: { id: saleId },
  });

  if (!sale || sale.businessId !== sourceBusinessId) {
    throw new AppError(404, 'Sale not found or does not belong to this business', 'SALE_NOT_FOUND');
  }

  // 3. Check month locking for both businesses
  await assertMonthNotLocked(sourceBusinessId, sale.transactionDate);
  await assertMonthNotLocked(targetBusinessId, sale.transactionDate);

  // 4. Duplicate reference check on target business if referenceId exists
  if (sale.referenceId) {
    const existingRef = await prisma.salesTransaction.findFirst({
      where: {
        businessId: targetBusinessId,
        source: sale.source,
        referenceId: sale.referenceId,
      },
      select: { id: true },
    });

    if (existingRef) {
      throw new AppError(
        409,
        `Target business already has a transaction with reference ${sale.referenceId}`,
        'DUPLICATE_SALES_REFERENCE'
      );
    }
  }

  // 5. Atomic reassignment
  const updatedSale = await prisma.$transaction(async (tx) => {
    const updated = await tx.salesTransaction.update({
      where: { id: saleId },
      data: { businessId: targetBusinessId },
    });

    await logAudit(
      {
        userId,
        businessId: targetBusinessId,
        action: 'sale.reassigned',
        resourceType: 'sales_transaction',
        resourceId: saleId,
        oldData: {
          businessId: sourceBusinessId,
          businessName: sourceBusiness.businessName,
          amount: toNumber(sale.amount),
        },
        newData: {
          businessId: targetBusinessId,
          businessName: targetBusiness.businessName,
          amount: toNumber(sale.amount),
        },
      },
      tx
    );

    return updated;
  });

  logger.info('Sale reassigned to another business', {
    saleId,
    sourceBusinessId,
    targetBusinessId,
    amount: toNumber(sale.amount),
  });

  return updatedSale;
}
