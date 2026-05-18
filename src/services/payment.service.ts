import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { processDVAAssignmentWebhook, processDVATransferWebhook } from '@/services/dva.service';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira, formatTaxMonth } from '@/lib/format';

// Fire a `payment_successful` reminder outside the caller's transaction.
// Fire-and-forget — a reminder failure must never block payment confirmation.
async function firePaymentSuccessReminder(payment: {
  id: string;
  businessId: string;
  taxReportId: string;
  amount: unknown;
}) {
  try {
    const report = await prisma.monthlyTaxReport.findUnique({
      where: { id: payment.taxReportId },
      select: { taxMonth: true },
    });
    if (!report) return;

    const monthLabel = formatTaxMonth(report.taxMonth);
    const amountLabel = formatNaira(payment.amountPaid as never);

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

  // Generate unique reference
  const reference = `PMT-${businessId.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  // Create pending payment record
  const payment = await prisma.taxPayment.create({
    data: {
      businessId,
      taxReportId,
      amountPaid: amount,
      paymentMethod: 'card',
      transactionReference: reference,
      paymentStatus: 'pending',
    },
  });

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
  // Verify HMAC-SHA512 signature
  const hash = crypto
    .createHmac('sha512', config.paystack.webhookSecret)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    throw new AppError(401, 'Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  const event = JSON.parse(rawBody);

  // ─── DVA Assignment Webhooks ──────────────────────────────
  if (event.event === 'dedicatedaccount.assign.success' || event.event === 'dedicatedaccount.assign.failed') {
    await processDVAAssignmentWebhook(event);
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
      amount: payment.amountPaid,
    });
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
      amount: updated.amount,
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
