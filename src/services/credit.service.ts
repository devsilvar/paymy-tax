import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { toNumber, resolveTransactionDateForLockedMonth } from '@/shared/helpers';
import { formatNaira, formatDateISO } from '@/lib/format';
import {
  CreateCreditInput,
  RecordPaymentInput,
  UpdateCreditInput,
  WriteOffCreditInput,
  CreditsQueryInput,
  CreditLineItemInput,
} from '@/validators/credit.validator';

const TX_OPTIONS = { maxWait: 10000, timeout: 25000 };

/**
 * Computes line totals and grand total for credit items with 2-decimal rounding.
 */
export function computeCreditTotal(items: CreditLineItemInput[]): {
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

export async function createCredit(userId: string, businessId: string, data: CreateCreditInput) {
  await verifyBusinessOwnership(userId, businessId);

  const hasItems = data.items !== undefined && data.items.length > 0;
  const { total: computedTotal, lines } = hasItems
    ? computeCreditTotal(data.items!)
    : { total: 0, lines: [] };
  const effectiveTotalAmount = hasItems ? computedTotal : data.totalAmount!;

  let description = data.description;
  if (!description && hasItems) {
    const itemSummary = data.items!.map((i) => `${i.name} (${i.quantity})`).join(', ');
    description = `${data.items!.length} item${data.items!.length > 1 ? 's' : ''}: ${itemSummary}`.slice(0, 500);
  }

  return prisma.$transaction(async (tx) => {
    const credit = await tx.customerCredit.create({
      data: {
        businessId,
        customerName: data.customerName,
        customerEmail: data.customerEmail || null,
        customerPhone: data.customerPhone || null,
        description: description || 'Credit obligation',
        totalAmount: effectiveTotalAmount,
        balance: effectiveTotalAmount,
        amountPaid: 0,
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        reminderDate: data.reminderDate || null,
        customerId: data.customerId || null,
        guarantorName: data.guarantorName || null,
        guarantorPhone: data.guarantorPhone || null,
        notes: data.notes || null,
        status: 'unpaid',
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

    await logAudit({
      userId,
      businessId,
      action: 'credit.created',
      resourceType: 'customer_credit',
      resourceId: credit.id,
      newData: {
        customerName: data.customerName,
        totalAmount: effectiveTotalAmount,
        dueDate: data.dueDate,
        itemsCount: hasItems ? lines.length : 0,
      },
    }, tx);

    return credit;
  }, TX_OPTIONS);
}

export async function recordPayment(userId: string, businessId: string, creditId: string, data: RecordPaymentInput) {
  return prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    // Row-level lock — prevent concurrent double-payment
    const credits = await tx.$queryRaw<any[]>`
      SELECT * FROM customer_credits WHERE id = ${creditId} FOR UPDATE
    `;
    const credit = credits[0];
    if (!credit || credit.business_id !== businessId) {
      throw new AppError(404, 'Credit not found', 'CREDIT_NOT_FOUND');
    }

    const currentStatus = credit.status as string;
    if (!['unpaid', 'partially_paid', 'overdue'].includes(currentStatus)) {
      throw new AppError(409, 'Credit is already settled or written off', 'CREDIT_CLOSED');
    }

    const currentBalance = toNumber(credit.balance);
    if (data.amount > currentBalance) {
      throw new AppError(400, `Payment of ₦${data.amount.toLocaleString()} exceeds remaining balance of ${formatNaira(currentBalance)}`, 'CREDIT_OVERPAYMENT');
    }

    // Resolve locked-month date adjustment (CRITICAL)
    const dateRes = await resolveTransactionDateForLockedMonth(businessId, data.paymentDate, tx);
    const effectiveDate = dateRes.effectiveDate;
    if (dateRes.wasAdjusted) {
      logger.warn('Credit payment date adjusted from locked/finalized month', {
        creditId, businessId,
        originalDate: dateRes.originalDate?.toISOString(),
        effectiveDate: effectiveDate.toISOString(),
        reason: dateRes.reason,
      });
    }

    const classification = await tx.transactionClassification.findFirst({
      where: { name: 'Credit / Debt Settlement', isActive: true },
    });

    const newAmountPaid = toNumber(credit.amount_paid) + data.amount;
    const newBalance = toNumber(credit.total_amount) - newAmountPaid;
    const isFullPayment = newBalance <= 0;

    // Create SalesTransaction — revenue recognized NOW
    const sale = await tx.salesTransaction.create({
      data: {
        businessId,
        amount: data.amount,
        source: data.paymentType,
        status: 'confirmed',
        isTaxable: true,
        referenceId: null,
        description: `Credit payment from ${credit.customer_name}`,
        customerName: credit.customer_name,
        transactionDate: effectiveDate,
        createdBy: userId,
        finalClassification: 'Credit / Debt Settlement',
        classificationId: classification?.id || null,
        metadata: {
          creditId,
          creditPaymentType: 'manual',
          isFullPayment,
          ...(dateRes.wasAdjusted ? {
            dateAdjustedFromLockedMonth: true,
            originalPaymentDate: dateRes.originalDate?.toISOString(),
            adjustmentReason: dateRes.reason,
          } : {}),
        },
      },
    });

    // Create CreditPayment record
    await tx.creditPayment.create({
      data: {
        creditId,
        amount: data.amount,
        paymentDate: effectiveDate,
        paymentType: data.paymentType,
        isFullPayment,
        linkedSaleId: sale.id,
        notes: data.notes || null,
      },
    });

    // Update credit balance
    const updated = await tx.customerCredit.update({
      where: { id: creditId },
      data: {
        amountPaid: newAmountPaid,
        balance: Math.max(0, newBalance),
        status: isFullPayment ? 'paid' : 'partially_paid',
      },
      include: { payments: { orderBy: { createdAt: 'desc' } } },
    });

    await logAudit({
      userId, businessId,
      action: 'credit.payment_recorded',
      resourceType: 'customer_credit',
      resourceId: creditId,
      oldData: { balance: currentBalance, status: currentStatus },
      newData: {
        balance: Math.max(0, newBalance),
        status: updated.status,
        saleId: sale.id,
        amount: data.amount,
        isFullPayment,
      },
    }, tx);

    logger.info('Credit payment recorded', {
      creditId, saleId: sale.id, amount: data.amount,
      newBalance: Math.max(0, newBalance), isFullPayment, businessId, userId,
    });

    return updated;
  }, TX_OPTIONS);
}

export async function writeOffCredit(userId: string, businessId: string, creditId: string, data: WriteOffCreditInput) {
  await verifyBusinessOwnership(userId, businessId);

  return prisma.$transaction(async (tx) => {
    const credit = await tx.customerCredit.findUnique({
      where: { id: creditId },
    });

    if (!credit || credit.businessId !== businessId) {
      throw new AppError(404, 'Credit not found', 'CREDIT_NOT_FOUND');
    }

    if (credit.status === 'paid' || credit.status === 'written_off') {
      throw new AppError(409, 'Credit is already settled or written off', 'CREDIT_CLOSED');
    }

    const writeOffNote = `[Written off: ${new Date().toISOString().slice(0, 10)}] ${data.reason}`;
    const updatedNotes = credit.notes ? `${credit.notes}\n${writeOffNote}` : writeOffNote;

    const updated = await tx.customerCredit.update({
      where: { id: creditId },
      data: {
        status: 'written_off',
        notes: updatedNotes,
      },
    });

    await logAudit({
      userId, businessId,
      action: 'credit.written_off',
      resourceType: 'customer_credit',
      resourceId: creditId,
      oldData: { status: credit.status },
      newData: { status: 'written_off', reason: data.reason },
    }, tx);

    return updated;
  }, TX_OPTIONS);
}

export async function listCredits(userId: string, businessId: string, query: CreditsQueryInput) {
  await verifyBusinessOwnership(userId, businessId);

  const page = query.page;
  const limit = query.limit;
  const skip = (page - 1) * limit;

  const where: any = { businessId };
  if (query.status) {
    where.status = query.status;
  }
  if (query.search) {
    where.customerName = {
      contains: query.search,
      mode: 'insensitive',
    };
  }

  const [total, data] = await Promise.all([
    prisma.customerCredit.count({ where }),
    prisma.customerCredit.findMany({
      where,
      skip,
      take: limit,
      orderBy: { dueDate: 'asc' },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    }),
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

export async function getCreditById(userId: string, businessId: string, creditId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const credit = await prisma.customerCredit.findUnique({
    where: { id: creditId },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
        include: { linkedSale: true },
      },
      customer: true,
    },
  });

  if (!credit || credit.businessId !== businessId) {
    throw new AppError(404, 'Credit not found', 'CREDIT_NOT_FOUND');
  }

  return credit;
}

export async function updateCredit(userId: string, businessId: string, creditId: string, data: UpdateCreditInput) {
  await verifyBusinessOwnership(userId, businessId);

  return prisma.$transaction(async (tx) => {
    const credit = await tx.customerCredit.findUnique({
      where: { id: creditId },
    });

    if (!credit || credit.businessId !== businessId) {
      throw new AppError(404, 'Credit not found', 'CREDIT_NOT_FOUND');
    }

    if (credit.status === 'paid' || credit.status === 'written_off') {
      throw new AppError(409, 'Credit cannot be updated once settled or written off', 'CREDIT_CLOSED');
    }

    if (data.dueDate && new Date(data.dueDate) < new Date(credit.issueDate)) {
      throw new AppError(400, 'Due date cannot be before credit issue date', 'INVALID_DUE_DATE');
    }
    const effectiveDueDate = data.dueDate ? new Date(data.dueDate) : new Date(credit.dueDate);
    if (data.reminderDate && new Date(data.reminderDate) > effectiveDueDate) {
      throw new AppError(400, 'Reminder date cannot be after due date', 'INVALID_REMINDER_DATE');
    }

    const updated = await tx.customerCredit.update({
      where: { id: creditId },
      data: {
        ...(data.customerName !== undefined && { customerName: data.customerName }),
        ...(data.customerPhone !== undefined && { customerPhone: data.customerPhone || null }),
        ...(data.customerEmail !== undefined && { customerEmail: data.customerEmail || null }),
        description: data.description,
        dueDate: data.dueDate,
        reminderDate: data.reminderDate || null,
        notes: data.notes || null,
        guarantorName: data.guarantorName || null,
        guarantorPhone: data.guarantorPhone || null,
      },
    });

    await logAudit({
      userId, businessId,
      action: 'credit.updated',
      resourceType: 'customer_credit',
      resourceId: creditId,
      oldData: credit,
      newData: updated,
    }, tx);

    return updated;
  }, TX_OPTIONS);
}

export async function getCreditsSummary(userId: string, businessId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const currentDate = new Date();
  const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

  const [aggregations, activeDebtorsResult, recoveredThisMonthResult] = await Promise.all([
    prisma.customerCredit.groupBy({
      by: ['status'],
      where: {
        businessId,
        status: { in: ['unpaid', 'partially_paid', 'overdue'] },
      },
      _sum: {
        balance: true,
      },
    }),
    prisma.customerCredit.findMany({
      where: {
        businessId,
        status: { in: ['unpaid', 'partially_paid', 'overdue'] },
      },
      select: { customerName: true },
      distinct: ['customerName'],
    }),
    prisma.creditPayment.aggregate({
      where: {
        credit: { businessId },
        paymentDate: { gte: firstDayOfMonth },
      },
      _sum: {
        amount: true,
      },
    }),
  ]);

  let totalOutstanding = 0;
  let overdueAmount = 0;

  aggregations.forEach((agg: any) => {
    const amount = agg._sum.balance ? Number(agg._sum.balance) : 0;
    totalOutstanding += amount;
    if (agg.status === 'overdue') {
      overdueAmount += amount;
    }
  });

  return {
    totalOutstanding,
    overdueAmount,
    activeDebtors: activeDebtorsResult.length,
    recoveredThisMonth: recoveredThisMonthResult._sum.amount ? Number(recoveredThisMonthResult._sum.amount) : 0,
  };
}

export async function reconcileDvaTransferToCredit(userId: string, businessId: string, creditId: string, saleId: string) {
  await verifyBusinessOwnership(userId, businessId);

  return prisma.$transaction(async (tx) => {
    const sale = await tx.salesTransaction.findUnique({
      where: { id: saleId },
    });

    if (!sale || sale.businessId !== businessId) {
      throw new AppError(404, 'Sale transaction not found', 'SALE_NOT_FOUND');
    }

    if (!sale.dvaOrigin && !sale.needsVerification && sale.source !== 'bank_transfer') {
      throw new AppError(400, 'Transaction is not eligible for DVA reconciliation', 'INVALID_RECONCILIATION');
    }

    const existingPayment = await tx.creditPayment.findUnique({
      where: { linkedSaleId: saleId },
    });

    if (existingPayment) {
      throw new AppError(409, 'Sale transaction has already been reconciled', 'SALE_ALREADY_RECONCILED');
    }

    const credit = await tx.customerCredit.findUnique({
      where: { id: creditId },
    });

    if (!credit || credit.businessId !== businessId) {
      throw new AppError(404, 'Credit not found', 'CREDIT_NOT_FOUND');
    }

    if (!['unpaid', 'partially_paid', 'overdue'].includes(credit.status)) {
      throw new AppError(409, 'Credit is already settled or written off', 'CREDIT_CLOSED');
    }

    const classification = await tx.transactionClassification.findFirst({
      where: { name: 'Credit / Debt Settlement', isActive: true },
    });

    const amount = toNumber(sale.amount);
    const newAmountPaid = toNumber(credit.amountPaid) + amount;
    const newBalance = toNumber(credit.totalAmount) - newAmountPaid;
    const isFullPayment = newBalance <= 0;

    await tx.salesTransaction.update({
      where: { id: saleId },
      data: {
        needsVerification: false,
        verifiedAt: new Date(),
        verifiedBy: userId,
        status: 'confirmed',
        finalClassification: 'Credit / Debt Settlement',
        classificationId: classification?.id || null,
        customerName: credit.customerName,
      },
    });

    await tx.creditPayment.create({
      data: {
        creditId,
        amount,
        paymentDate: sale.transactionDate,
        paymentType: 'bank_transfer',
        isFullPayment,
        linkedSaleId: saleId,
        notes: isFullPayment && newBalance < 0
          ? `Settled in full (Overpayment of ₦${Math.abs(newBalance).toLocaleString()} recorded via bank transfer)`
          : undefined,
      },
    });

    const updated = await tx.customerCredit.update({
      where: { id: creditId },
      data: {
        amountPaid: newAmountPaid,
        balance: Math.max(0, newBalance),
        status: isFullPayment ? 'paid' : 'partially_paid',
      },
    });

    await logAudit({
      userId, businessId,
      action: 'credit.dva_reconciled',
      resourceType: 'customer_credit',
      resourceId: creditId,
      newData: {
        saleId,
        amount,
        status: updated.status,
      },
    }, tx);

    return updated;
  }, TX_OPTIONS);
}

export async function getWhatsAppReminderLink(userId: string, businessId: string, creditId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const credit = await prisma.customerCredit.findUnique({
    where: { id: creditId },
    include: { business: true },
  });

  if (!credit || credit.businessId !== businessId) {
    throw new AppError(404, 'Credit not found', 'CREDIT_NOT_FOUND');
  }

  const phone = credit.customerPhone;
  if (!phone) {
    throw new AppError(400, 'Customer does not have a phone number', 'NO_PHONE_NUMBER');
  }

  let normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone.startsWith('0')) {
    normalizedPhone = '234' + normalizedPhone.slice(1);
  } else if (!normalizedPhone.startsWith('234')) {
    normalizedPhone = '234' + normalizedPhone;
  }

  const businessName = credit.business.businessName;
  const customerName = credit.customerName;
  const balance = Number(credit.balance);
  const dueDate = credit.dueDate;

  const msg = `Dear ${customerName}, this is a payment reminder from ${businessName}. Your outstanding balance of ${formatNaira(balance)} was due on ${formatDateISO(dueDate)}. Please arrange payment at your earliest convenience. Thank you.`;

  const encodedMsg = encodeURIComponent(msg);

  await prisma.customerCredit.update({
    where: { id: creditId },
    data: { lastReminderSentAt: new Date() },
  });

  await logAudit({
    userId,
    businessId,
    action: 'credit.whatsapped',
    resourceType: 'customer_credit',
    resourceId: creditId,
    newData: { phone: normalizedPhone, balance },
  });

  return {
    waUrl: `https://wa.me/${normalizedPhone}?text=${encodedMsg}`,
    message: msg,
  };
}
