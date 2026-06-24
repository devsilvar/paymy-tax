import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
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

// ─── Helpers ────────────────────────────────────────────────

async function verifyBusinessOwnership(userId: string, businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  return business;
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

  // Idempotency: if an open pending payment already exists for this report,
  // reuse it instead of spawning a second Paystack transaction. Guards against
  // double-clicks, refreshes, back-button, and multiple tabs — without
  // requiring the client to send an idempotency key. Paystack's
  // /transaction/initialize is itself idempotent on `reference`, so
  // re-initializing the same reference returns the same checkout session.
  // A stale pending whose amount no longer matches the report (sales/expenses
  // edited between attempts) is abandoned and replaced so the SME is never
  // sent to pay the wrong figure.
  const existingPending = await prisma.taxPayment.findFirst({
    where: { taxReportId, paymentStatus: 'pending' },
    orderBy: { createdAt: 'desc' },
  });

  let payment = existingPending;

  if (existingPending && Number(existingPending.amountPaid) !== amount) {
    await prisma.taxPayment.update({
      where: { id: existingPending.id },
      data: { paymentStatus: 'failed', gatewayResponse: { abandoned: 'amount_changed' } },
    });
    payment = null;
  }

  if (!payment) {
    // Generate unique reference
    const reference = `PMT-${businessId.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Create pending payment record
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
      await prisma.paystackWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'failed', error: 'Duplicate signature (replay attack)', processedAt: new Date() },
      });
      throw new AppError(401, 'Duplicate webhook signature detected', 'REPLAY_ATTACK');
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
