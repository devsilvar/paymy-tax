import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { verifyBusinessOwnership } from '@/lib/ownership';
import {
  processDVAAssignmentWebhook,
  processDVATransferWebhook,
  processCustomerIdentificationWebhook,
} from '@/services/dva.service';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira, formatTaxMonth } from '@/lib/format';

// Fire a `payment_successful` reminder outside the caller's transaction.
// Fire-and-forget — a reminder failure must never block payment confirmation.
async function firePaymentSuccessReminder(payment: {
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

async function dispatchPaymentReceiptEmail(payment: {
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

// ─── Helpers ────────────────────────────────────────────────

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
    callbackUrl,
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

// ─── Webhook Processing ─────────────────────────────────────

export async function processWebhook(signature: string, rawBody: string) {
  const eventData = JSON.parse(rawBody);
  const reference = eventData?.data?.reference || eventData?.data?.dedicated_account?.account_number || null;

  // Log event BEFORE signature verification (even rejected events)
  const webhookEvent = await prisma.paystackWebhookEvent.create({
    data: {
      event: eventData.event || 'unknown',
      reference,
      signature,
      rawBody,
      status: 'received',
    },
  });

  try {
    // Replay prevention: check for duplicate signature in last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const duplicate = await prisma.paystackWebhookEvent.findFirst({
      where: {
        signature,
        createdAt: { gte: fiveMinutesAgo },
        id: { not: webhookEvent.id },
      },
    });

    if (duplicate) {
      // A duplicate signature means Paystack redelivered an event we already
      // received — same raw body hashes to the same HMAC every time. That's
      // normal retry behavior (e.g. our 200 response got lost), not a forged
      // replay. Acknowledge it as already-handled (200) instead of rejecting
      // it (401): rejecting tells Paystack the delivery failed, so they retry
      // again, hit this same check, get rejected again, and repeat up to 25
      // times over 2 weeks without ever recording a successful delivery.
      await prisma.paystackWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'processed', error: 'Duplicate delivery — already handled', processedAt: new Date() },
      });
      return;
    }

    // Verify HMAC-SHA512 signature
    const hash = crypto
      .createHmac('sha512', config.paystack.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (hash !== signature) {
      await prisma.paystackWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'failed', error: 'Invalid signature', processedAt: new Date() },
      });
      throw new AppError(401, 'Invalid webhook signature', 'INVALID_SIGNATURE');
    }

    const event = eventData;

  // ─── DVA Assignment Webhooks ──────────────────────────────
  if (event.event === 'dedicatedaccount.assign.success' || event.event === 'dedicatedaccount.assign.failed') {
    await processDVAAssignmentWebhook(event);
    return;
  }

  // ─── Customer Identification Webhooks (async BVN validation result) ──
  if (
    event.event === 'customeridentification.success' ||
    event.event === 'customeridentification.failed'
  ) {
    await processCustomerIdentificationWebhook(event);
    return;
  }

  if (event.event === 'charge.success') {
    // Check if this is a DVA transfer (auto-record as sale) before handling as tax payment
    const isDVATransfer = await processDVATransferWebhook(event);
    if (isDVATransfer) return;

    const { reference, amount, paid_at, channel, gateway_response } = event.data;

    const payment = await prisma.taxPayment.findFirst({
      where: { transactionReference: reference },
    });

    if (!payment) {
      logger.warn('Webhook received for unknown payment reference', { reference });
      return;
    }

    if (payment.paymentStatus === 'completed') {
      logger.info('Duplicate webhook for already completed payment', { reference });
      return;
    }

    // Update payment and report in a transaction
    await prisma.$transaction(async (tx) => {
      await tx.taxPayment.update({
        where: { id: payment.id },
        data: {
          paymentStatus: 'completed',
          paymentDate: new Date(paid_at),
          paymentMethod: channel || 'card',
          gatewayResponse: event.data,
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
    });

    logAudit({
      businessId: payment.businessId,
      action: 'payment.completed',
      resourceType: 'tax_payment',
      resourceId: payment.id,
      newData: { reference, amount: amount / 100, channel, gateway_response },
    });

    logger.info('Payment completed via webhook', { paymentId: payment.id, reference });

    // Fire-and-forget reminder. Replayed webhooks are deduped by referenceId.
    void firePaymentSuccessReminder({
      id: payment.id,
      businessId: payment.businessId,
      taxReportId: payment.taxReportId,
      amountPaid: Number(payment.amountPaid),
    });

    // Fire-and-forget email receipt with PDF attachment
    void dispatchPaymentReceiptEmail({
      id: payment.id,
      businessId: payment.businessId,
      taxReportId: payment.taxReportId,
      amountPaid: Number(payment.amountPaid),
      transactionReference: reference,
      paymentDate: paid_at ? new Date(paid_at) : new Date(),
    });
  }

  if (event.event === 'charge.refunded') {
    const { reference } = event.data;

    // Check if this was a tax payment
    const payment = await prisma.taxPayment.findFirst({
      where: { transactionReference: reference },
    });

    if (payment) {
      await prisma.taxPayment.update({
        where: { id: payment.id },
        data: { paymentStatus: 'refunded' },
      });

      logAudit({
        businessId: payment.businessId,
        action: 'payment.refunded',
        resourceType: 'tax_payment',
        resourceId: payment.id,
        newData: { reference },
      });

      await createReminderOnce({
        businessId: payment.businessId,
        reminderType: 'payment_refunded',
        scheduledDate: new Date(),
        message: `Your tax payment of ${formatNaira(Number(payment.amountPaid))} was refunded`,
      });

      logger.info('Tax payment refunded', { paymentId: payment.id, reference });
      return;
    }

    // Check if this was a DVA transfer (reverse the sale)
    const sale = await prisma.salesTransaction.findFirst({
      where: { referenceId: reference, source: 'bank_transfer' },
    });

    if (sale) {
      await prisma.salesTransaction.update({
        where: { id: sale.id },
        data: { status: 'reversed' },
      });

      logAudit({
        businessId: sale.businessId,
        action: 'sale.reversed',
        resourceType: 'sales_transaction',
        resourceId: sale.id,
        newData: { reference, reason: 'refunded' },
      });

      logger.info('DVA sale reversed due to refund', { saleId: sale.id, reference });
      return;
    }

    // Check if this was an invoice payment (find by linkedSale referenceId)
    const invoice = await prisma.invoice.findFirst({
      where: {
        linkedSale: {
          referenceId: reference,
          source: 'online_store',
        },
      },
      include: { linkedSale: true },
    });

    if (invoice && invoice.linkedSale) {
      await prisma.$transaction(async (tx) => {
        // Update invoice to unpaid
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            status: 'overdue',
            paidAt: null,
            linkedSaleId: null,
          },
        });

        // Reverse the linked sale
        await tx.salesTransaction.update({
          where: { id: invoice.linkedSale.id },
          data: { status: 'reversed' },
        });
      });

      logAudit({
        businessId: invoice.businessId,
        action: 'invoice.refunded',
        resourceType: 'invoice',
        resourceId: invoice.id,
        newData: { reference },
      });

      logger.info('Invoice refunded and unlinked', { invoiceId: invoice.id, reference });
    }
  }

    // Mark webhook as processed
    await prisma.paystackWebhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: 'processed', processedAt: new Date() },
    });
  } catch (err) {
    // Log failure and re-throw
    await prisma.paystackWebhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        processedAt: new Date(),
      },
    }).catch(() => {}); // ignore DB errors during error handling

    throw err;
  }
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