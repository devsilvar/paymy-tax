import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import { getRemittanceTransport } from '@/lib/remittance';

// ─── FIRS Remittance Tracking ───────────────────────────────
//
// SMEs pay tax via Paystack, which pools the money in the PLATFORM balance
// (tax payments go through /transaction/initialize, not the SME's settlement
// subaccount). This service tracks whether that collected tax is forwarded to
// FIRS. A `FirsRemittance` batch groups many completed payments; an admin
// records one manual remittance (FIRS ref + receipt) and every member payment
// inherits it. No real FIRS transport exists yet — see lib/remittance.

// ─── Collected Summary (admin "ready to remit" card) ────────

export async function getCollectedSummary() {
  const agg = await prisma.taxPayment.aggregate({
    where: { paymentStatus: 'completed', remittanceStatus: 'collected' },
    _sum: { amountPaid: true },
    _count: true,
  });

  return {
    collectedTotal: Number(agg._sum.amountPaid ?? 0),
    collectedCount: agg._count,
  };
}

// ─── Create Batch ───────────────────────────────────────────
//
// Groups collected payments into a `remitting` batch. If `paymentIds` are
// supplied, every one must currently be completed+collected (else 409). With
// no ids, sweeps ALL collectable payments.

export async function createRemittanceBatch(
  adminId: string,
  paymentIds?: string[],
) {
  return prisma.$transaction(async (tx) => {
    const where: Prisma.TaxPaymentWhereInput = {
      paymentStatus: 'completed',
      remittanceStatus: 'collected',
      ...(paymentIds && paymentIds.length > 0 ? { id: { in: paymentIds } } : {}),
    };

    const payments = await tx.taxPayment.findMany({
      where,
      select: { id: true, amountPaid: true },
    });

    // If the caller named specific ids, every one must be collectable.
    if (paymentIds && paymentIds.length > 0 && payments.length !== paymentIds.length) {
      throw new AppError(
        409,
        'One or more payments are not in a collectable state (must be completed and not yet remitted)',
        'PAYMENT_NOT_COLLECTABLE',
      );
    }

    if (payments.length === 0) {
      throw new AppError(400, 'No collected payments to remit', 'NOTHING_TO_REMIT');
    }

    const totalAmount = payments.reduce((sum, p) => sum + Number(p.amountPaid), 0);

    const batch = await tx.firsRemittance.create({
      data: {
        status: 'remitting',
        totalAmount,
        paymentCount: payments.length,
        transport: 'manual',
        createdBy: adminId,
      },
    });

    await tx.taxPayment.updateMany({
      where: { id: { in: payments.map((p) => p.id) } },
      data: { remittanceStatus: 'remitting', remittanceId: batch.id },
    });

    logAudit(
      {
        userId: adminId,
        action: 'firs_remittance.batch_created',
        resourceType: 'firs_remittance',
        resourceId: batch.id,
        newData: { totalAmount, paymentCount: payments.length },
      },
      tx,
    );

    return batch;
  });
}

// ─── Record Remittance (mark batch remitted to FIRS) ────────

export async function recordRemittance(
  adminId: string,
  remittanceId: string,
  params: { firsReference: string; firsReceiptUrl?: string; note?: string; transport?: string },
) {
  const batch = await prisma.firsRemittance.findUnique({ where: { id: remittanceId } });

  if (!batch) {
    throw new AppError(404, 'Remittance batch not found', 'REMITTANCE_NOT_FOUND');
  }

  if (batch.status === 'remitted') {
    throw new AppError(409, 'This remittance has already been recorded', 'ALREADY_REMITTED');
  }

  // Run the transport OUTSIDE the transaction — a future real driver performs a
  // network call here and must not hold DB locks (same rule as bcrypt/email).
  const transportName = params.transport ?? 'manual';
  const result = await getRemittanceTransport(transportName).submit({
    remittanceId,
    firsReference: params.firsReference,
    firsReceiptUrl: params.firsReceiptUrl,
    note: params.note,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const batchUpdated = await tx.firsRemittance.update({
      where: { id: remittanceId },
      data: {
        status: 'remitted',
        firsReference: result.firsReference,
        firsReceiptUrl: result.firsReceiptUrl ?? null,
        transport: transportName,
        note: params.note ?? null,
        remittedAt: result.remittedAt,
      },
    });

    // Denormalize the FIRS ref/receipt onto each member payment so the existing
    // firsRemittanceRef/firsReceiptUrl columns are populated and the SME view
    // can show proof per payment without joining the batch.
    await tx.taxPayment.updateMany({
      where: { remittanceId },
      data: {
        remittanceStatus: 'remitted',
        firsRemittanceRef: result.firsReference,
        firsReceiptUrl: result.firsReceiptUrl ?? null,
      },
    });

    logAudit(
      {
        userId: adminId,
        action: 'firs_remittance.recorded',
        resourceType: 'firs_remittance',
        resourceId: remittanceId,
        newData: {
          firsReference: result.firsReference,
          transport: transportName,
          paymentCount: batchUpdated.paymentCount,
          totalAmount: Number(batchUpdated.totalAmount),
        },
      },
      tx,
    );

    return batchUpdated;
  });

  logger.info('FIRS remittance recorded', {
    remittanceId,
    firsReference: result.firsReference,
    paymentCount: updated.paymentCount,
  });

  return updated;
}

// ─── List / Get Batches ─────────────────────────────────────

export async function listRemittances(
  page: number,
  limit: number,
  status?: 'collected' | 'remitting' | 'remitted',
) {
  const where: Prisma.FirsRemittanceWhereInput = status ? { status } : {};
  const offset = (page - 1) * limit;

  const [data, total] = await Promise.all([
    prisma.firsRemittance.findMany({
      where,
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.firsRemittance.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data,
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

export async function getRemittance(remittanceId: string) {
  const batch = await prisma.firsRemittance.findUnique({
    where: { id: remittanceId },
    include: {
      payments: {
        select: {
          id: true,
          businessId: true,
          amountPaid: true,
          transactionReference: true,
          paymentDate: true,
          remittanceStatus: true,
        },
        orderBy: { paymentDate: 'desc' },
      },
    },
  });

  if (!batch) {
    throw new AppError(404, 'Remittance batch not found', 'REMITTANCE_NOT_FOUND');
  }

  return batch;
}
