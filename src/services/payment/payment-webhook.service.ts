import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import {
  processDVAAssignmentWebhook,
  processDVATransferWebhook,
  processCustomerIdentificationWebhook,
} from '@/services/dva.service';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';
import { toNumber } from '@/shared/helpers';
import { eventBus } from '@/core/events';
import { WalletService } from '@/services/wallet.service';
import { firePaymentSuccessReminder, dispatchPaymentReceiptEmail } from './tax-payment.service';

// ─── Webhook Processing ─────────────────────────────────────

export async function processWebhook(signature: string, rawBody: string) {
  // STEP 1: Verify HMAC-SHA512 signature in-memory FIRST. Zero database writes on forgery.
  const hash = crypto
    .createHmac('sha512', config.paystack.webhookSecret)
    .update(rawBody)
    .digest('hex');

  const hashBuf = Buffer.from(hash, 'utf8');
  const sigBuf = Buffer.from(signature || '', 'utf8');

  if (hashBuf.length !== sigBuf.length || !crypto.timingSafeEqual(hashBuf, sigBuf)) {
    logger.warn('Paystack webhook rejected: invalid HMAC signature');
    throw new AppError(401, 'Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  // STEP 2: Defensively parse JSON payload with explicit error handling
  let eventData: any;
  try {
    eventData = JSON.parse(rawBody);
  } catch (parseErr) {
    logger.error('Paystack webhook rejected: malformed JSON payload', {
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    throw new AppError(400, 'Invalid JSON payload', 'INVALID_JSON');
  }

  const reference = eventData?.data?.reference || eventData?.data?.dedicated_account?.account_number || null;

  // STEP 3: Replay prevention: check for duplicate signature in last 5 minutes
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const duplicate = await prisma.paystackWebhookEvent.findFirst({
    where: {
      signature,
      createdAt: { gte: fiveMinutesAgo },
    },
  });

  if (duplicate) {
    logger.info('Duplicate webhook delivery ignored — already handled', { signature, reference });
    return;
  }

  // STEP 4: Persist verified webhook event
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

      // ─── Storefront Order Payments ──────────────────────────────
      // When a storefront order is paid (card, paycode, or DVA), route to store order pipeline
      if (reference && typeof reference === 'string' && reference.startsWith('ORD-')) {
        const orderPayload = {
          orderId: event.data.metadata?.orderId || reference,
          storeId: event.data.metadata?.storeId || 'unknown-store',
          businessId: event.data.metadata?.businessId || 'unknown-business',
          userId: event.data.metadata?.userId || 'unknown-user',
          amount: Number(amount) / 100,
          orderNumber: reference,
          customerName: `${event.data.customer?.first_name || ''} ${event.data.customer?.last_name || ''}`.trim() || 'Store Customer',
          customerPhone: event.data.customer?.phone || '',
          items: Array.isArray(event.data.metadata?.items) ? event.data.metadata.items : [],
        };

        logAudit({
          businessId: orderPayload.businessId,
          action: 'store.order_payment_received',
          resourceType: 'order',
          resourceId: orderPayload.orderId,
          newData: { reference, amount: orderPayload.amount, channel, gateway_response },
        });

        logger.info('Storefront order payment received via webhook, emitting order.payment_confirmed', {
          reference,
          orderId: orderPayload.orderId,
          amount: orderPayload.amount,
        });

        eventBus.emit('order.payment_confirmed', orderPayload);
        return;
      }

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

      // Check if this was a storefront order refund
      if (reference && typeof reference === 'string' && reference.startsWith('ORD-')) {
        logger.info('Storefront order refund webhook received, acknowledged', { reference });
        return;
      }

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
        return;
      }
    }

    // ─── Settlement Payout Transfer Webhooks ───────────────────
    if (event.event === 'transfer.success') {
      const transferData = event.data || {};
      const ref = transferData.reference;
      const transferCode = transferData.transfer_code;

      const payout = await prisma.settlementPayout.findFirst({
        where: {
          OR: [
            ...(ref ? [{ transferReference: ref }] : []),
            ...(transferCode ? [{ paystackTransferCode: transferCode }] : []),
          ],
        },
        include: { business: { select: { userId: true, businessName: true } } },
      });

      if (payout) {
        const wasCompleted = payout.status === 'completed';

        await prisma.settlementPayout.update({
          where: { id: payout.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });

        // Settle wallet payout debit if not already settled
        if (!wasCompleted && payout.business?.userId) {
          await WalletService.settlePayoutDebit({
            userId: payout.business.userId,
            businessId: payout.businessId,
            amount: payout.amount,
            fee: 0,
            reference: payout.transferReference,
            linkedPayoutId: payout.id,
            description: `Settlement payout completed to ${payout.destinationBankName}`,
          });

          // Post-commit event emission for webhook completion
          eventBus.emit('payout.completed', {
            userId: payout.business.userId,
            payoutId: payout.id,
            amount: toNumber(payout.amount),
            reference: payout.transferReference,
          });
        }

        logAudit({
          businessId: payout.businessId,
          action: 'settlement.payout_completed',
          resourceType: 'settlement_payout',
          resourceId: payout.id,
          newData: { reference: ref, transferCode },
        });

        logger.info('Settlement payout marked completed via webhook', {
          payoutId: payout.id,
          reference: ref,
        });

        void createReminderOnce({
          businessId: payout.businessId,
          reminderType: 'payout_completed',
          scheduledDate: new Date(),
          // What LANDED in the bank is netAmount (amount minus Paystack's
          // transfer fee + stamp duty). Legacy rows written before fees were
          // modelled have netAmount === amount, so the fallback stays correct.
          message: `Your withdrawal of ${formatNaira(
            Number(payout.netAmount) > 0 ? Number(payout.netAmount) : Number(payout.amount)
          )} (ref ${ref || payout.transferReference}) was successfully transferred to your ${payout.destinationBankName} account.`,
          referenceType: 'settlement_payout',
          referenceId: payout.id,
        }).catch((err) =>
          logger.warn('Failed to create payout_completed reminder', {
            payoutId: payout.id,
            err: err instanceof Error ? err.message : err,
          })
        );
      }
    }

    if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
      const transferData = event.data || {};
      const ref = transferData.reference;
      const transferCode = transferData.transfer_code;
      const reason = transferData.reason || event.event;

      const payout = await prisma.settlementPayout.findFirst({
        where: {
          OR: [
            ...(ref ? [{ transferReference: ref }] : []),
            ...(transferCode ? [{ paystackTransferCode: transferCode }] : []),
          ],
        },
        include: { business: { select: { userId: true } } },
      });

      if (payout) {
        const wasPendingOrProcessing =
          payout.status === 'pending' || payout.status === 'processing';

        await prisma.settlementPayout.update({
          where: { id: payout.id },
          data: {
            status: 'failed',
            failureReason: reason,
          },
        });

        // Release locked funds back to available wallet balance
        if (wasPendingOrProcessing && payout.business?.userId) {
          await WalletService.releaseLockedFunds({
            userId: payout.business.userId,
            amount: payout.amount,
            fee: 0,
          });
        }

        logAudit({
          businessId: payout.businessId,
          action: 'settlement.payout_failed',
          resourceType: 'settlement_payout',
          resourceId: payout.id,
          newData: { reference: ref, transferCode, reason },
        });

        logger.info('Settlement payout marked failed via webhook', {
          payoutId: payout.id,
          reference: ref,
          reason,
        });

        void createReminderOnce({
          businessId: payout.businessId,
          reminderType: 'payout_failed',
          scheduledDate: new Date(),
          message: `Your withdrawal transfer of ${formatNaira(Number(payout.amount))} (ref ${ref || payout.transferReference}) failed: ${reason || 'Bank transfer could not be completed'}. The funds remain available in your balance.`,
          referenceType: 'settlement_payout',
          referenceId: payout.id,
        }).catch((err) =>
          logger.warn('Failed to create payout_failed reminder', {
            payoutId: payout.id,
            err: err instanceof Error ? err.message : err,
          })
        );
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
