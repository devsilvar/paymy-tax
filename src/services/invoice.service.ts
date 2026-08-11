import crypto from 'crypto';
import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { buildInvoicePdf } from '@/services/invoice.pdf';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira, formatDateISO } from '@/lib/format';
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
function maybeFireOverdueReminderOnSend(invoice: {
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

async function verifyBusinessOwnership(
  userId: string,
  businessId: string,
  db: TxClient | typeof prisma = prisma,
) {
  const business = await db.business.findUnique({ where: { id: businessId } });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  return business;
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/** Round to 2 decimals (money). */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

type SalesSourceType = 'bank_transfer' | 'paycode' | 'pos' | 'online_store' | 'manual' | 'cash' | 'invoice';

/** Map the invoice payment method enum to a SalesTransaction source value.
 *  
 *  Strategy: All invoice payments use source='invoice' (to distinguish invoiced
 *  revenue from direct sales) EXCEPT cash payments which use source='cash' to
 *  maintain consistent cash tracking across the system.
 *  
 *  The specific payment method (bank_transfer, pos, card, etc.) is still tracked
 *  in the invoice.paymentMethod field. This creates clean reporting:
 *  - 'invoice' source = all invoiced revenue regardless of payment channel
 *  - 'cash' source = all cash transactions (direct sales + cash-paid invoices)
 */
function paymentMethodToSalesSource(method: InvoicePaymentMethod): SalesSourceType {
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
function computeTotals(
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
 * Per-business, per-year sequence, min 3-digit zero padding (e.g. INV-2026-001,
 * INV-2026-042). Grows naturally past 999 — INV-2026-1000, INV-2026-10000, etc.
 *
 * We order by `createdAt desc`, NOT by `invoiceNumber desc`. Since the number is
 * assigned at insert time inside this transaction, creation order tracks the
 * numeric sequence exactly — and unlike lexicographic sort on the string, this
 * stays correct once the suffix grows past 3 digits ("INV-2026-1000" sorts
 * BEFORE "INV-2026-999" as a string).
 *
 * Runs inside the invoice-create transaction, so concurrent creates are
 * serialized. The unique constraint (businessId, invoiceNumber) is the final
 * safety net.
 */
async function generateInvoiceNumber(
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

  // padStart is a no-op once next ≥ 1000, so the format degrades gracefully.
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

    logAudit(
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
        },
      },
      tx,
    );

    logger.info('Invoice created', {
      invoiceId: invoice.id,
      invoiceNumber,
      businessId,
      userId,
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

    // Only draft invoices can be edited. Once sent or paid, edits are blocked
    // because the customer has already received the document.
    if (existing.status !== 'draft') {
      throw new AppError(
        409,
        `Cannot edit invoice in '${existing.status}' status. Only draft invoices are editable.`,
        'INVOICE_NOT_EDITABLE',
      );
    }

    // Build patch
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

    // Recompute totals if money or lines changed
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
        // Replace all line items atomically
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

    logAudit(
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
        newData: data,
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

    // Only draft invoices can be deleted. Sent/paid invoices must be cancelled
    // (preserves audit trail and referential integrity with linked sales).
    if (existing.status !== 'draft') {
      throw new AppError(
        409,
        `Cannot delete invoice in '${existing.status}' status. Cancel it instead.`,
        'INVOICE_NOT_DELETABLE',
      );
    }

    await tx.invoice.delete({ where: { id: invoiceId } });

    logAudit(
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

// ─── Lifecycle actions ──────────────────────────────────────

/**
 * Guard: tax month containing `date` must not be finalized or locked, because
 * marking an invoice paid creates a SalesTransaction in that month — which
 * would silently bypass the finalization freeze.
 */
async function assertMonthNotLocked(
  businessId: string,
  date: Date,
  db: TxClient | typeof prisma,
) {
  // UTC — taxMonth is written in UTC by calculateTax; local-tz derivation
  // would miss the row on UTC+ hosts and let an invoice be marked paid in
  // a locked month.
  const monthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  );

  const report = await db.monthlyTaxReport.findUnique({
    where: { businessId_taxMonth: { businessId, taxMonth: monthStart } },
    select: { isLocked: true, isFinalized: true },
  });

  if (report?.isLocked) {
    throw new AppError(
      423,
      'This month is locked — tax has been paid. Cannot record a payment against it.',
      'PERIOD_LOCKED',
    );
  }
  if (report?.isFinalized) {
    throw new AppError(
      423,
      'This month is finalized. Un-finalize it before recording a payment.',
      'PERIOD_FINALIZED',
    );
  }
}

/**
 * Mark an invoice as sent. Transitions: draft → sent.
 * Idempotency: we deliberately refuse if already sent — the caller should
 * know whether they meant "send again" (out of scope) vs "confirm sent".
 */
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

    logAudit(
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

/**
 * Mark an invoice as paid and atomically record revenue as a SalesTransaction.
 *
 * Transitions: draft | sent | overdue → paid.
 * Refuses if already paid or cancelled.
 *
 * The linked sale uses:
 *  - amount = invoice.total (gross, VAT-inclusive — that's what the customer paid)
 *  - source = 'manual' (user-recorded; 'bank_transfer' is reserved for DVA auto-capture)
 *  - transactionDate = paymentDate (defaults to today)
 *  - referenceId = invoiceNumber (unique per business via unique_sales_reference,
 *    so marking the same invoice paid twice would fail at the DB — another safety net)
 */
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
      // Draft invoices haven't been issued to the customer — paying one
      // suggests the workflow is being skipped. Require send first.
      throw new AppError(
        409,
        'Send the invoice to the customer before marking it paid.',
        'INVOICE_NOT_SENT',
      );
    }

    const paymentDate = input.paymentDate ?? new Date();

    // Payment date must not be before the invoice was issued.
    if (paymentDate < existing.issueDate) {
      throw new AppError(
        400,
        'Payment date cannot be before the invoice issue date',
        'INVALID_PAYMENT_DATE',
      );
    }

    // Revenue lands in the month of paymentDate — refuse if that month is locked.
    await assertMonthNotLocked(businessId, paymentDate, tx);

    const total = toNumber(existing.total);

    // Map the payment method to a SalesSource so the linked sale reflects how
    // the customer actually paid rather than hardcoding 'manual'.
    const mappedSource = paymentMethodToSalesSource(input.paymentMethod);

    // Create the SalesTransaction first, then link it on the invoice.
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

    logAudit(
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

/**
 * Cancel an invoice. Transitions: draft | sent | overdue → cancelled.
 * Refuses if already paid (a paid invoice represents booked revenue; reversing
 * it requires a refund workflow, which isn't in scope here) or already cancelled.
 */
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

    logAudit(
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

// ─── PDF ────────────────────────────────────────────────────

/**
 * Generate a customer-facing PDF for the given invoice.
 * Returns the raw PDF bytes + a suggested filename. The controller sets the
 * response headers; this keeps the service free of Express types.
 *
 * We deliberately do NOT refuse generating a PDF for a draft/cancelled invoice
 * — the user may want to preview a draft before sending, or retain a PDF record
 * of a cancelled one. The status badge in the PDF itself makes the state clear.
 */
export async function generateInvoicePdf(
  userId: string,
  businessId: string,
  invoiceId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });

  if (!invoice || invoice.businessId !== businessId) {
    throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }

  const buffer = await buildInvoicePdf(
    {
      businessName: business.businessName,
      merchantId: business.merchantId,
      ownerName: business.ownerName,
      taxId: business.taxId,
      address: business.address,
      city: business.city,
      state: business.state,
    },
    invoice,
  );

  const filename = `${invoice.invoiceNumber}.pdf`;

  logAudit({
    userId,
    businessId,
    action: 'invoice.pdf_downloaded',
    resourceType: 'invoice',
    resourceId: invoiceId,
    newData: { invoiceNumber: invoice.invoiceNumber, status: invoice.status },
  });

  logger.info('Invoice PDF generated', {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    bytes: buffer.length,
    businessId,
    userId,
  });

  return { buffer, filename };
}

// ─── Public share token + public PDF ────────────────────────

/**
 * Generate an opaque share token for an invoice.
 *
 * 32 hex chars (16 bytes of entropy) — same crypto-random pattern used for
 * password reset tokens. Long enough to be unguessable, short enough to fit
 * in a WhatsApp message without forcing a line wrap.
 */
function generateShareToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Lazily ensure an invoice has a `shareToken`, returning the token. Idempotent —
 * once issued it is reused so the link the SME has already pasted into a chat
 * keeps working. Runs in its own short transaction so the caller can decide
 * whether to do this inside or outside another tx (this one is standalone for
 * use from sendInvoiceByWhatsApp's pre-tx setup).
 */
export async function ensureInvoiceShareToken(
  businessId: string,
  invoiceId: string,
  tx?: TxClient,
): Promise<string> {
  const db = tx ?? prisma;
  const existing = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { shareToken: true, businessId: true },
  });
  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  if (existing.shareToken) return existing.shareToken;

  // Tiny race window: two concurrent sends could each generate a token. The
  // unique index on share_token makes a duplicate insert fail; on conflict
  // we re-read and use whichever token won. In practice the SME only triggers
  // one share at a time, so this is belt-and-braces.
  const token = generateShareToken();
  try {
    await db.invoice.update({
      where: { id: invoiceId },
      data: { shareToken: token },
    });
    return token;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const reread = await db.invoice.findUnique({
        where: { id: invoiceId },
        select: { shareToken: true },
      });
      if (reread?.shareToken) return reread.shareToken;
    }
    throw err;
  }
}

/**
 * Fetch + render an invoice PDF via its public share token. NO auth — this is
 * the endpoint customers click from a WhatsApp message. Throws 404 if the token
 * is unknown (or `cancelled` invoices, which should not be visible publicly).
 *
 * Cancelled invoices return 410 Gone rather than 404 so the SME can tell the
 * difference if they accidentally cancelled an invoice they had already shared.
 */
export async function getPublicInvoicePdfByToken(
  token: string,
): Promise<{ buffer: Buffer; filename: string }> {
  if (!token || token.length < 16) {
    throw new AppError(404, 'Invoice link is invalid or has expired.', 'INVOICE_LINK_INVALID');
  }

  const invoice = await prisma.invoice.findUnique({
    where: { shareToken: token },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      business: true,
    },
  });

  if (!invoice) {
    throw new AppError(404, 'Invoice link is invalid or has expired.', 'INVOICE_LINK_INVALID');
  }

  if (invoice.status === 'cancelled') {
    throw new AppError(410, 'This invoice was cancelled by the sender.', 'INVOICE_CANCELLED');
  }

  const buffer = await buildInvoicePdf(
    {
      businessName: invoice.business.businessName,
      merchantId: invoice.business.merchantId,
      ownerName: invoice.business.ownerName,
      taxId: invoice.business.taxId,
      address: invoice.business.address,
      city: invoice.business.city,
      state: invoice.business.state,
    },
    invoice,
  );

  logger.info('Public invoice PDF served', {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    businessId: invoice.businessId,
    bytes: buffer.length,
  });

  return { buffer, filename: `${invoice.invoiceNumber}.pdf` };
}

// ─── Electronic delivery (WhatsApp) ──────────────────────────

function formatNairaMinor(n: number): string {
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateHuman(d: Date): string {
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Normalize a phone number into E.164-style digits (no leading `+`) for wa.me.
 * Handles common Nigerian inputs:
 *   +234 803 123 4567 → 2348031234567
 *   0803 123 4567     → 2348031234567
 *   803 123 4567      → 2348031234567 (assumes NG if 10 digits)
 *   2348031234567     → 2348031234567
 * For any other country code the user should enter with leading `+`.
 */
function normalizePhoneForWa(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Keep digits only after stripping a possible leading +
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;

  if (hasPlus) return digits;
  // Local NG format: 0xxxxxxxxxx (11 digits)
  if (digits.startsWith('0') && digits.length === 11) return `234${digits.slice(1)}`;
  // Already prefixed with 234
  if (digits.startsWith('234')) return digits;
  // 10-digit NG without leading 0
  if (digits.length === 10) return `234${digits}`;
  // Fallback — assume user knows what they entered
  return digits;
}

/**
 * Build the customer-facing PDF URL for a share token. The customer taps this
 * from a WhatsApp message and the public route streams the PDF inline.
 */
function buildPublicInvoiceLink(shareToken: string): string {
  const base = (
    process.env.PUBLIC_API_URL ||
    process.env.FRONTEND_URL ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
  return `${base}/api/v1/public/invoices/${shareToken}/pdf`;
}

/**
 * Build a wa.me deep link for the customer's phone and generate the PDF buffer
 * for direct attachment in WhatsApp. The client receives both the PDF file and
 * message metadata to enable native file sharing on mobile or direct PDF sending.
 *
 * Allowed in any non-cancelled state: draft (first send), sent/overdue
 * (collections follow-up), paid (forward a receipt). The wording in `message`
 * adapts based on whether the invoice is settled.
 *
 * Side effects: lazily issues a `shareToken` on the invoice on first call;
 * transitions draft → sent (idempotent for re-sends).
 */
export async function sendInvoiceByWhatsApp(
  userId: string,
  businessId: string,
  invoiceId: string,
): Promise<{
  invoice: any;
  waUrl: string;
  message: string;
  pdfUrl: string;
  pdfBuffer: Buffer;
  filename: string;
  to: string;
}> {
  const business = await verifyBusinessOwnership(userId, businessId);

  const existing = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  if (existing.status === 'cancelled') {
    throw new AppError(409, 'Cannot send a cancelled invoice.', 'INVOICE_CANCELLED');
  }
  if (!existing.customerPhone) {
    throw new AppError(
      400,
      'This invoice has no customer phone. Add one by editing the invoice.',
      'INVOICE_NO_PHONE',
    );
  }

  const normalized = normalizePhoneForWa(existing.customerPhone);
  if (!normalized) {
    throw new AppError(
      400,
      'Customer phone number appears invalid. Edit the invoice and enter a valid phone number.',
      'INVOICE_INVALID_PHONE',
    );
  }

  // Issue / reuse the share token BEFORE the status-flip transaction so the
  // PDF link is ready when we build the message body. Uses its own short tx
  // internally — same pattern as bcrypt outside transactions.
  const shareToken = await ensureInvoiceShareToken(businessId, invoiceId);

  // Generate the PDF buffer for direct attachment
  const pdfBuffer = await buildInvoicePdf(
    {
      businessName: business.businessName,
      merchantId: business.merchantId,
      ownerName: business.ownerName,
      taxId: business.taxId,
      address: business.address,
      city: business.city,
      state: business.state,
    },
    existing,
  );

  const total = toNumber(existing.total);
  const pdfUrl = buildPublicInvoiceLink(shareToken);
  const isPaid = existing.status === 'paid';
  const filename = `${existing.invoiceNumber}.pdf`;

  const message = isPaid
    ? [
        `Hi ${existing.customerName},`,
        ``,
        `Receipt for invoice ${existing.invoiceNumber} from ${business.businessName}.`,
        `Amount paid: ${formatNairaMinor(total)}`,
        existing.paidAt ? `Paid on: ${formatDateHuman(existing.paidAt)}` : '',
        ``,
        `— Sent via PayMyTax by WallX`,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        `Hi ${existing.customerName},`,
        ``,
        `Invoice ${existing.invoiceNumber} from ${business.businessName}.`,
        `Amount due: ${formatNairaMinor(total)}`,
        `Due date: ${formatDateHuman(existing.dueDate)}`,
        existing.paymentTerms ? `\nPayment terms:\n${existing.paymentTerms}` : '',
        ``,
        `— Sent via PayMyTax by WallX`,
      ]
        .filter(Boolean)
        .join('\n');

  const waUrl = `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;

  const updated = await prisma.$transaction(async (tx) => {
    const wasDraft = existing.status === 'draft';
    const data: Record<string, any> = {};
    if (wasDraft) {
      data.status = 'sent';
      data.sentAt = new Date();
    }

    const updatedInvoice = Object.keys(data).length
      ? await tx.invoice.update({
          where: { id: invoiceId },
          data,
          include: { lines: { orderBy: { sortOrder: 'asc' } }, linkedSale: true },
        })
      : await tx.invoice.findUnique({
          where: { id: invoiceId },
          include: { lines: { orderBy: { sortOrder: 'asc' } }, linkedSale: true },
        });

    logAudit(
      {
        userId,
        businessId,
        action: 'invoice.whatsapped',
        resourceType: 'invoice',
        resourceId: invoiceId,
        oldData: { status: existing.status },
        newData: {
          to: normalized,
          statusAfter: wasDraft ? 'sent' : existing.status,
          paid: isPaid,
        },
      },
      tx,
    );

    return updatedInvoice;
  });

  logger.info('Invoice PDF generated for WhatsApp', {
    invoiceId,
    invoiceNumber: existing.invoiceNumber,
    to: normalized,
    businessId,
    userId,
    paid: isPaid,
    pdfBytes: pdfBuffer.length,
  });

  if (updated) maybeFireOverdueReminderOnSend(updated);

  return { invoice: updated, waUrl, message, pdfUrl, pdfBuffer, filename, to: normalized };
}
