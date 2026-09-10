import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira, formatDateISO } from '@/lib/format';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { toNumber, assertMonthNotLocked, resolveTransactionDateForLockedMonth } from '@/shared/helpers';
import {
  CreateInvoiceInput,
  UpdateInvoiceInput,
  InvoicesQueryInput,
  InvoiceLineInput,
  MarkInvoicePaidInput,
  CancelInvoiceInput,
  InvoicePaymentMethod,
} from '@/validators/invoice.validator';

// Fire an `invoice_overdue` reminder if the invoice was sent with a dueDate
// already in the past (backdated). The nightly cron handles the mainline
// case (sent invoices that became overdue overnight); this is the safety
// net at send-time. Fire-and-forget — never blocks the send response.
export function maybeFireOverdueReminderOnSend(invoice: {
  id: string;
  businessId: string;
  invoiceNumber: string;
  customerName: string;
  total: unknown;
  dueDate: Date;
  status: string;
}) {
  if (invoice.status !== 'sent') return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (invoice.dueDate >= today) return;

  void createReminderOnce({
    businessId: invoice.businessId,
    reminderType: 'invoice_overdue',
    scheduledDate: today,
    message: `Invoice ${invoice.invoiceNumber} to ${invoice.customerName} for ${formatNaira(
      invoice.total as never,
    )} is overdue (was due ${formatDateISO(invoice.dueDate)}).`,
    referenceType: 'invoice',
    referenceId: invoice.id,
  }).catch((err) =>
    logger.warn('Failed to create invoice_overdue reminder on send', {
      invoiceId: invoice.id,
      err: err instanceof Error ? err.message : err,
    }),
  );
}

// ─── Helpers ────────────────────────────────────────────────

/** Round to 2 decimals (money). */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export type SalesSourceType = 'bank_transfer' | 'paycode' | 'pos' | 'online_store' | 'manual' | 'cash' | 'invoice';

/** Map the invoice payment method enum to a SalesTransaction source value. */
export function paymentMethodToSalesSource(method: InvoicePaymentMethod): SalesSourceType {
  const map: Record<InvoicePaymentMethod, SalesSourceType> = {
    cash: 'cash',              // Cash payments tracked separately
    bank_transfer: 'invoice',  // Invoice settlement via bank
    pos: 'invoice',            // Invoice settlement via POS
    card: 'invoice',           // Invoice settlement via card
    mobile_money: 'invoice',   // Invoice settlement via mobile money
    cheque: 'invoice',         // Invoice settlement via cheque
    online: 'invoice',         // Invoice settlement via online payment
    other: 'invoice',          // Invoice settlement via other method
  };
  return map[method] ?? 'invoice';
}

/**
 * Compute invoice totals from line items + rate + discount.
 * VAT is applied on (subtotal - discount), per FIRS standard.
 */
export function computeTotals(
  lines: InvoiceLineInput[],
  vatRate: number,
  discount: number,
) {
  const enrichedLines = lines.map((l, i) => {
    const lineTotal = money(l.quantity * l.unitPrice);
    return { ...l, lineTotal, sortOrder: i };
  });

  const subtotal = money(enrichedLines.reduce((sum, l) => sum + l.lineTotal, 0));
  const taxable = Math.max(0, money(subtotal - discount));
  const vatAmount = money((taxable * vatRate) / 100);
  const total = money(taxable + vatAmount);

  return { enrichedLines, subtotal, vatAmount, total };
}

/**
 * Generate the next invoice number for a business in the format INV-{YYYY}-{NNN}.
 */
export async function generateInvoiceNumber(
  businessId: string,
  year: number,
  db: TxClient | typeof prisma,
): Promise<string> {
  const prefix = `INV-${year}-`;

  const lastInvoice = await db.invoice.findFirst({
    where: {
      businessId,
      invoiceNumber: { startsWith: prefix },
    },
    orderBy: { createdAt: 'desc' },
    select: { invoiceNumber: true },
  });

  let next = 1;
  if (lastInvoice) {
    const suffix = lastInvoice.invoiceNumber.slice(prefix.length);
    const parsed = parseInt(suffix, 10);
    if (!Number.isNaN(parsed)) next = parsed + 1;
  }

  return `${prefix}${next.toString().padStart(3, '0')}`;
}

// ─── CRUD ───────────────────────────────────────────────────

export async function createInvoice(
  userId: string,
  businessId: string,
  input: CreateInvoiceInput,
) {
  return prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    const vatRate = input.vatRate ?? 7.5;
    const discount = input.discount ?? 0;
    const { enrichedLines, subtotal, vatAmount, total } = computeTotals(
      input.lines,
      vatRate,
      discount,
    );

    const invoiceNumber = await generateInvoiceNumber(
      businessId,
      input.issueDate.getFullYear(),
      tx,
    );

    const invoice = await tx.invoice.create({
      data: {
        businessId,
        invoiceNumber,
        status: 'draft',
        issueDate: input.issueDate,
        dueDate: input.dueDate,

        customerName: input.customerName,
        customerEmail: input.customerEmail || undefined,
        customerPhone: input.customerPhone || undefined,
        customerAddress: input.customerAddress || undefined,
        customerTaxId: input.customerTaxId || undefined,

        subtotal,
        vatRate,
        vatAmount,
        discount,
        total,
        currency: input.currency ?? 'NGN',

        notes: input.notes || undefined,
        paymentTerms: input.paymentTerms || undefined,

        createdBy: userId,

        lines: {
          create: enrichedLines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            sortOrder: l.sortOrder,
          })),
        },
      },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });

    await logAudit(
      {
        userId,
        businessId,
        action: 'invoice.created',
        resourceType: 'invoice',
        resourceId: invoice.id,
        newData: {
          invoiceNumber,
          total,
          customerName: input.customerName,
          linesCount: input.lines.length,
        },
      },
      tx,
    );

    logger.info('Invoice created', {
      invoiceId: invoice.id,
      invoiceNumber,
      businessId,
      userId,
      total,
    });

    return invoice;
  });
}

export async function listInvoices(
  userId: string,
  businessId: string,
  query: InvoicesQueryInput,
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
      { customerName: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.startDate || query.endDate) {
    where.issueDate = {};
    if (query.startDate) where.issueDate.gte = query.startDate;
    if (query.endDate) where.issueDate.lte = query.endDate;
  }

  const offset = (query.page - 1) * query.limit;

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      skip: offset,
      take: query.limit,
      orderBy: { issueDate: 'desc' },
      include: {
        _count: { select: { lines: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: invoices,
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

export async function getInvoiceById(
  userId: string,
  businessId: string,
  invoiceId: string,
) {
  await verifyBusinessOwnership(userId, businessId);

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      linkedSale: true,
    },
  });

  if (!invoice || invoice.businessId !== businessId) {
    throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }

  return invoice;
}

export async function updateInvoice(
  userId: string,
  businessId: string,
  invoiceId: string,
  input: UpdateInvoiceInput,
) {
  return prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    const existing = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    if (!existing || existing.businessId !== businessId) {
      throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
    }

    if (existing.status !== 'draft') {
      throw new AppError(
        409,
        `Cannot edit invoice in '${existing.status}' status. Only draft invoices are editable.`,
        'INVOICE_NOT_EDITABLE',
      );
    }

    const data: Record<string, any> = {};
    if (input.issueDate !== undefined) data.issueDate = input.issueDate;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.notes !== undefined) data.notes = input.notes || null;
    if (input.paymentTerms !== undefined) data.paymentTerms = input.paymentTerms || null;

    if (input.customerName !== undefined) data.customerName = input.customerName;
    if (input.customerEmail !== undefined) data.customerEmail = input.customerEmail || null;
    if (input.customerPhone !== undefined) data.customerPhone = input.customerPhone || null;
    if (input.customerAddress !== undefined)
      data.customerAddress = input.customerAddress || null;
    if (input.customerTaxId !== undefined) data.customerTaxId = input.customerTaxId || null;

    const vatRateChanged = input.vatRate !== undefined;
    const discountChanged = input.discount !== undefined;
    const linesChanged = input.lines !== undefined;

    if (vatRateChanged || discountChanged || linesChanged) {
      const lines = linesChanged
        ? input.lines!
        : existing.lines.map((l) => ({
            description: l.description,
            quantity: toNumber(l.quantity),
            unitPrice: toNumber(l.unitPrice),
          }));
      const vatRate = vatRateChanged ? input.vatRate! : toNumber(existing.vatRate);
      const discount = discountChanged ? input.discount! : toNumber(existing.discount);

      const { enrichedLines, subtotal, vatAmount, total } = computeTotals(
        lines,
        vatRate,
        discount,
      );
      data.subtotal = subtotal;
      data.vatRate = vatRate;
      data.vatAmount = vatAmount;
      data.discount = discount;
      data.total = total;

      if (linesChanged) {
        await tx.invoiceLine.deleteMany({ where: { invoiceId } });
        await tx.invoiceLine.createMany({
          data: enrichedLines.map((l) => ({
            invoiceId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            sortOrder: l.sortOrder,
          })),
        });
      }
    }

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data,
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });

    await logAudit(
      {
        userId,
        businessId,
        action: 'invoice.updated',
        resourceType: 'invoice',
        resourceId: invoiceId,
        oldData: {
          total: toNumber(existing.total),
          status: existing.status,
        },
        newData: {
          total: toNumber(updated.total),
          status: updated.status,
          updatedFields: Object.keys(input),
        },
      },
      tx,
    );

    logger.info('Invoice updated', { invoiceId, businessId, userId });

    return updated;
  });
}

export async function deleteInvoice(
  userId: string,
  businessId: string,
  invoiceId: string,
) {
  return prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    const existing = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!existing || existing.businessId !== businessId) {
      throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
    }

    if (existing.status !== 'draft') {
      throw new AppError(
        409,
        `Cannot delete invoice in '${existing.status}' status. Cancel it instead.`,
        'INVOICE_NOT_DELETABLE',
      );
    }

    await tx.invoice.delete({ where: { id: invoiceId } });

    await logAudit(
      {
        userId,
        businessId,
        action: 'invoice.deleted',
        resourceType: 'invoice',
        resourceId: invoiceId,
        oldData: {
          invoiceNumber: existing.invoiceNumber,
          total: toNumber(existing.total),
        },
      },
      tx,
    );

    logger.info('Invoice deleted', { invoiceId, businessId, userId });

    return { message: 'Invoice deleted successfully' };
  });
}

export async function sendInvoice(
  userId: string,
  businessId: string,
  invoiceId: string,
) {
  const updated = await prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    const existing = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!existing || existing.businessId !== businessId) {
      throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
    }

    if (existing.status !== 'draft') {
      throw new AppError(
        409,
        `Cannot send invoice in '${existing.status}' status. Only draft invoices can be sent.`,
        'INVOICE_NOT_SENDABLE',
      );
    }

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: 'sent', sentAt: new Date() },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });

    await logAudit(
      {
        userId,
        businessId,
        action: 'invoice.sent',
        resourceType: 'invoice',
        resourceId: invoiceId,
        oldData: { status: existing.status },
        newData: { status: 'sent', sentAt: updated.sentAt },
      },
      tx,
    );

    logger.info('Invoice sent', {
      invoiceId,
      invoiceNumber: existing.invoiceNumber,
      businessId,
      userId,
    });

    return updated;
  });

  maybeFireOverdueReminderOnSend(updated);
  return updated;
}

export async function markInvoicePaid(
  userId: string,
  businessId: string,
  invoiceId: string,
  input: MarkInvoicePaidInput,
) {
  return prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    const existing = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!existing || existing.businessId !== businessId) {
      throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
    }

    if (existing.status === 'paid') {
      throw new AppError(409, 'Invoice is already paid', 'INVOICE_ALREADY_PAID');
    }
    if (existing.status === 'cancelled') {
      throw new AppError(
        409,
        'Cannot pay a cancelled invoice. Create a new invoice instead.',
        'INVOICE_CANCELLED',
      );
    }
    if (existing.status === 'draft') {
      throw new AppError(
        409,
        'Send the invoice to the customer before marking it paid.',
        'INVOICE_NOT_SENT',
      );
    }

    const rawPaymentDate = input.paymentDate ?? new Date();

    if (rawPaymentDate < existing.issueDate) {
      throw new AppError(
        400,
        'Payment date cannot be before the invoice issue date',
        'INVALID_PAYMENT_DATE',
      );
    }

    const dateRes = await resolveTransactionDateForLockedMonth(businessId, rawPaymentDate, tx);
    const paymentDate = dateRes.effectiveDate;
    if (dateRes.wasAdjusted) {
      logger.warn('Invoice paymentDate adjusted from locked/finalized month to current active month', {
        invoiceId,
        businessId,
        originalDate: dateRes.originalDate?.toISOString(),
        effectiveDate: paymentDate.toISOString(),
        reason: dateRes.reason,
      });
    }

    const total = toNumber(existing.total);
    const mappedSource = paymentMethodToSalesSource(input.paymentMethod);

    const sale = await tx.salesTransaction.create({
      data: {
        businessId,
        amount: total,
        source: mappedSource,
        status: 'confirmed',
        referenceId: existing.invoiceNumber,
        description: `Invoice ${existing.invoiceNumber} — ${existing.customerName}`,
        customerName: existing.customerName,
        transactionDate: paymentDate,
        createdBy: userId,
        metadata: {
          invoiceId: existing.id,
          invoiceNumber: existing.invoiceNumber,
          paymentMethod: input.paymentMethod,
          subtotal: toNumber(existing.subtotal),
          vatAmount: toNumber(existing.vatAmount),
          discount: toNumber(existing.discount),
          ...(dateRes.wasAdjusted
            ? {
                dateAdjustedFromLockedMonth: true,
                originalPaymentDate: dateRes.originalDate?.toISOString(),
                adjustmentReason: dateRes.reason,
              }
            : {}),
        },
      },
    });

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'paid',
        paidAt: paymentDate,
        paymentMethod: input.paymentMethod,
        linkedSaleId: sale.id,
      },
      include: {
        lines: { orderBy: { sortOrder: 'asc' } },
        linkedSale: true,
      },
    });

    await logAudit(
      {
        userId,
        businessId,
        action: 'invoice.paid',
        resourceType: 'invoice',
        resourceId: invoiceId,
        oldData: { status: existing.status },
        newData: {
          status: 'paid',
          paidAt: paymentDate,
          paymentMethod: input.paymentMethod,
          linkedSaleId: sale.id,
          amount: total,
        },
      },
      tx,
    );

    logger.info('Invoice marked paid and sale recorded', {
      invoiceId,
      invoiceNumber: existing.invoiceNumber,
      saleId: sale.id,
      amount: total,
      businessId,
      userId,
    });

    return updated;
  });
}

export async function cancelInvoice(
  userId: string,
  businessId: string,
  invoiceId: string,
  input: CancelInvoiceInput,
) {
  return prisma.$transaction(async (tx) => {
    await verifyBusinessOwnership(userId, businessId, tx);

    const existing = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!existing || existing.businessId !== businessId) {
      throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
    }

    if (existing.status === 'paid') {
      throw new AppError(
        409,
        'Cannot cancel a paid invoice. A refund would be required to reverse it.',
        'INVOICE_PAID',
      );
    }
    if (existing.status === 'cancelled') {
      throw new AppError(409, 'Invoice is already cancelled', 'INVOICE_ALREADY_CANCELLED');
    }

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: 'cancelled' },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });

    await logAudit(
      {
        userId,
        businessId,
        action: 'invoice.cancelled',
        resourceType: 'invoice',
        resourceId: invoiceId,
        oldData: { status: existing.status },
        newData: { status: 'cancelled', reason: input.reason || undefined },
      },
      tx,
    );

    logger.info('Invoice cancelled', {
      invoiceId,
      invoiceNumber: existing.invoiceNumber,
      previousStatus: existing.status,
      businessId,
      userId,
    });

    return updated;
  });
}
