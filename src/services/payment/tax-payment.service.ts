import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira, formatTaxMonth } from '@/lib/format';

// Fire a `payment_successful` reminder outside the caller's transaction.
// Fire-and-forget — a reminder failure must never block payment confirmation.
export async function firePaymentSuccessReminder(payment: {
  id: string;
  businessId: string;
  taxReportId: string;
  amountPaid: number | string;
}) {
  try {
    const report = await prisma.monthlyTaxReport.findUnique({
      where: { id: payment.taxReportId },
      select: { taxMonth: true },
    });
    if (!report) return;

    const monthLabel = formatTaxMonth(report.taxMonth);
    const amountLabel = formatNaira(payment.amountPaid);

    await createReminderOnce({
      businessId: payment.businessId,
      reminderType: 'payment_successful',
      scheduledDate: new Date(),
      message: `Your tax payment of ${amountLabel} for ${monthLabel} was confirmed. Download your statement from Payments.`,
      referenceType: 'payment',
      referenceId: payment.id,
    });
  } catch (err) {
    logger.warn('Failed to create payment_successful reminder', {
      paymentId: payment.id,
      err: err instanceof Error ? err.message : err,
    });
  }
}

export async function dispatchPaymentReceiptEmail(payment: {
  id: string;
  businessId: string;
  taxReportId: string;
  amountPaid: number | string;
  transactionReference: string;
  paymentDate?: Date;
}) {
  try {
    const business = await prisma.business.findUnique({
      where: { id: payment.businessId },
      include: { user: { select: { email: true } } },
    });
    const report = await prisma.monthlyTaxReport.findUnique({
      where: { id: payment.taxReportId },
    });

    if (!business || !report || !business.user?.email) return;

    const { getTaxPaymentReceipt } = await import('@/services/receipt.service');
    const { sendEmail } = await import('@/lib/email');
    const { generatePaymentReceiptHtml, generatePaymentReceiptText } = await import(
      '@/lib/email/templates/payment-receipt'
    );

    const receipt = await getTaxPaymentReceipt(business.userId, business.id, payment.id);
    const taxMonthLabel = formatTaxMonth(report.taxMonth);
    const amountFormatted = formatNaira(payment.amountPaid);
    const paymentDateStr = (payment.paymentDate || new Date()).toLocaleDateString('en-NG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    await sendEmail({
      to: business.user.email,
      subject: `Tax Payment Receipt - ${taxMonthLabel} (${amountFormatted})`,
      html: generatePaymentReceiptHtml({
        businessName: business.businessName,
        ownerName: business.ownerName,
        amountFormatted,
        taxMonthLabel,
        paymentReference: payment.transactionReference,
        paymentDate: paymentDateStr,
        receiptNumber: receipt.receiptNumber,
      }),
      text: generatePaymentReceiptText({
        businessName: business.businessName,
        ownerName: business.ownerName,
        amountFormatted,
        taxMonthLabel,
        paymentReference: payment.transactionReference,
        paymentDate: paymentDateStr,
        receiptNumber: receipt.receiptNumber,
      }),
      attachments: [
        {
          filename: receipt.filename,
          content: receipt.buffer,
          contentType: 'application/pdf',
        },
      ],
    });

    logger.info('Tax payment receipt email dispatched', { paymentId: payment.id, to: business.user.email });
  } catch (err) {
    logger.warn('Failed to send payment receipt email', {
      paymentId: payment.id,
      err: err instanceof Error ? err.message : err,
    });
  }
}

// ─── Initiate Payment ───────────────────────────────────────

export async function initiatePayment(
  userId: string,
  businessId: string,
  taxReportId: string,
  callbackUrl?: string
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // Get user email for Paystack
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  // Verify report exists, belongs to business, is finalized, and not already paid
  const report = await prisma.monthlyTaxReport.findUnique({ where: { id: taxReportId } });

  if (!report || report.businessId !== businessId) {
    throw new AppError(404, 'Tax report not found', 'REPORT_NOT_FOUND');
  }

  if (!report.isFinalized) {
    throw new AppError(400, 'Report must be finalized before payment', 'NOT_FINALIZED');
  }

  if (report.paymentStatus === 'completed') {
    throw new AppError(400, 'Report has already been paid', 'ALREADY_PAID');
  }

  const amount = typeof report.taxPayable === 'number'
    ? report.taxPayable
    : Number(report.taxPayable);

  if (amount <= 0) {
    throw new AppError(400, 'No tax payable for this report', 'ZERO_TAX');
  }

  // Idempotency: if an open pending or failed payment already exists for this
  // report, reuse it instead of spawning a second Paystack transaction. This
  // guards against double-clicks, refreshes, back-button, multiple tabs, and
  // most importantly: abandoned payments where the user cancelled on Paystack's
  // page and then tried again. Without this, the unique constraint on
  // transactionReference would cause a duplicate error on retry.
  //
  // Paystack's /transaction/initialize is itself idempotent on `reference`, so
  // re-initializing the same reference returns the same checkout session.
  //
  // A stale pending/failed payment whose amount no longer matches the report
  // (sales/expenses edited between attempts) is marked as abandoned and
  // replaced so the SME is never sent to pay the wrong figure.
  const existingPayment = await prisma.taxPayment.findFirst({
    where: { 
      taxReportId, 
      paymentStatus: { in: ['pending', 'failed'] }
    },
    orderBy: { createdAt: 'desc' },
  });

  let payment = existingPayment;

  // If amount changed, abandon old payment and create new one
  if (existingPayment && Number(existingPayment.amountPaid) !== amount) {
    await prisma.taxPayment.update({
      where: { id: existingPayment.id },
      data: { 
        paymentStatus: 'failed', 
        gatewayResponse: { abandoned: 'amount_changed', oldAmount: Number(existingPayment.amountPaid), newAmount: amount } 
      },
    });
    payment = null;
  }

  // If payment is too old (>1 hour), mark as abandoned and create fresh one
  // This prevents reusing stale sessions from days ago
  if (existingPayment && !payment && existingPayment.createdAt) {
    const ageMinutes = (Date.now() - existingPayment.createdAt.getTime()) / (1000 * 60);
    if (ageMinutes > 60) {
      await prisma.taxPayment.update({
        where: { id: existingPayment.id },
        data: { 
          paymentStatus: 'failed', 
          gatewayResponse: { abandoned: 'expired', ageMinutes: Math.round(ageMinutes) } 
        },
      });
      payment = null;
    }
  }

  if (!payment) {
    // Generate unique reference with timestamp and random bytes
    const reference = `PMT-${businessId.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Wrap in try-catch to handle potential duplicate reference edge case
    try {
      payment = await prisma.taxPayment.create({
        data: {
          businessId,
          taxReportId,
          amountPaid: amount,
          paymentMethod: 'card',
          transactionReference: reference,
          paymentStatus: 'pending',
        },
      });
    } catch (error: any) {
      // If we hit a unique constraint error (extremely rare), mark all old
      // pending/failed payments for this report as abandoned and retry once
      if (error.code === 'P2002' && error.meta?.target?.includes('transaction_reference')) {
        logger.warn('Duplicate transaction reference collision, cleaning up old payments', {
          taxReportId,
          reference,
        });

        await prisma.taxPayment.updateMany({
          where: { 
            taxReportId, 
            paymentStatus: { in: ['pending', 'failed'] } 
          },
          data: { 
            paymentStatus: 'failed', 
            gatewayResponse: { abandoned: 'duplicate_cleanup' } 
          },
        });

        // Generate new reference and retry
        const newReference = `PMT-${businessId.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        payment = await prisma.taxPayment.create({
          data: {
            businessId,
            taxReportId,
            amountPaid: amount,
            paymentMethod: 'card',
            transactionReference: newReference,
            paymentStatus: 'pending',
          },
        });
      } else {
        throw error;
      }
    }
  }

  const reference = payment.transactionReference;

  // Update report status to processing
  await prisma.monthlyTaxReport.update({
    where: { id: taxReportId },
    data: { paymentStatus: 'processing' },
  });

  const callback = callbackUrl || `${config.cors.frontendUrl}/payments/callback?businessId=${businessId}&reportId=${taxReportId}&paymentId=${payment.id}&reference=${reference}`;

  // Initialize with payment provider
  const provider = getPaymentProvider();
  const result = await provider.initialize({
    email: user.email,
    amount,
    reference,
    metadata: {
      paymentId: payment.id,
      businessId,
      taxReportId,
      businessName: business.businessName,
    },
    callbackUrl: callback,
  });

  logAudit({
    userId,
    businessId,
    action: 'payment.initiated',
    resourceType: 'tax_payment',
    resourceId: payment.id,
    newData: { amount, reference, taxReportId },
  });

  logger.info('Payment initiated', { paymentId: payment.id, reference, amount });

  return {
    paymentId: payment.id,
    reference,
    authorizationUrl: result.authorizationUrl,
    accessCode: result.accessCode,
  };
}

// ─── Verify Payment ─────────────────────────────────────────

export async function verifyPayment(userId: string, businessId: string, paymentId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const payment = await prisma.taxPayment.findUnique({ where: { id: paymentId } });

  if (!payment || payment.businessId !== businessId) {
    throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  }

  if (payment.paymentStatus === 'completed') {
    return payment;
  }

  // Verify with payment provider
  const provider = getPaymentProvider();
  const result = await provider.verify(payment.transactionReference);

  if (result.status === 'success') {
    const updated = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.taxPayment.update({
        where: { id: paymentId },
        data: {
          paymentStatus: 'completed',
          paymentDate: result.paidAt ? new Date(result.paidAt) : new Date(),
          paymentMethod: (result.channel as any) || 'card',
          gatewayResponse: result as any,
        },
      });

      await tx.monthlyTaxReport.update({
        where: { id: payment.taxReportId },
        data: {
          paymentStatus: 'completed',
          isLocked: true,
          lockedAt: new Date(),
        },
      });

      return updatedPayment;
    });

    logAudit({
      userId,
      businessId,
      action: 'payment.verified',
      resourceType: 'tax_payment',
      resourceId: paymentId,
      newData: { reference: payment.transactionReference, status: 'completed' },
    });

    // Fire-and-forget reminder. Idempotent on replay (deduped by referenceId).
    void firePaymentSuccessReminder({
      id: updated.id,
      businessId: updated.businessId,
      taxReportId: updated.taxReportId,
      amountPaid: Number(updated.amountPaid),
    });

    // Fire-and-forget email receipt with PDF attachment
    void dispatchPaymentReceiptEmail({
      id: updated.id,
      businessId: updated.businessId,
      taxReportId: updated.taxReportId,
      amountPaid: Number(updated.amountPaid),
      transactionReference: updated.transactionReference,
      paymentDate: updated.paymentDate || new Date(),
    });

    return updated;
  }

  // If failed, update status
  if (result.status === 'failed') {
    await prisma.taxPayment.update({
      where: { id: paymentId },
      data: {
        paymentStatus: 'failed',
        gatewayResponse: result as any,
      },
    });

    await prisma.monthlyTaxReport.update({
      where: { id: payment.taxReportId },
      data: { paymentStatus: 'failed' },
    });
  }

  return prisma.taxPayment.findUnique({ where: { id: paymentId } });
}

// ─── List Payments ──────────────────────────────────────────

export async function listPayments(
  userId: string,
  businessId: string,
  query: { page: number; limit: number; status?: string }
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };
  if (query.status) where.paymentStatus = query.status;

  const offset = (query.page - 1) * query.limit;

  const [payments, total] = await Promise.all([
    prisma.taxPayment.findMany({
      where,
      skip: offset,
      take: query.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.taxPayment.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: payments,
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

// ─── Get Single Payment ─────────────────────────────────────

export async function getPayment(userId: string, businessId: string, paymentId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const payment = await prisma.taxPayment.findUnique({ where: { id: paymentId } });

  if (!payment || payment.businessId !== businessId) {
    throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  }

  return payment;
}

// ─── Abandon Stale / Pending Payment ────────────────────────

export async function abandonPayment(userId: string, businessId: string, paymentId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const payment = await prisma.taxPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.businessId !== businessId) {
    throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  }

  if (payment.paymentStatus === 'completed') {
    throw new AppError(400, 'Cannot abandon an already completed payment', 'PAYMENT_ALREADY_COMPLETED');
  }

  const updatedPayment = await prisma.$transaction(async (tx) => {
    const p = await tx.taxPayment.update({
      where: { id: paymentId },
      data: {
        paymentStatus: 'failed',
        gatewayResponse: { abandoned: true, abandonedAt: new Date().toISOString() },
      },
    });

    // Reset report status back to pending so the SME can re-calculate or re-attempt payment
    await tx.monthlyTaxReport.update({
      where: { id: payment.taxReportId },
      data: { paymentStatus: 'pending' },
    });

    return p;
  });

  logAudit({
    userId,
    businessId,
    action: 'payment.abandoned',
    resourceType: 'tax_payment',
    resourceId: paymentId,
    newData: { reference: payment.transactionReference },
  });

  logger.info('Tax payment abandoned and report reset to pending', { paymentId, businessId });

  return updatedPayment;
}
