import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import logger from '@/lib/logger';
import { config } from '@/config';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';
import { invalidateOwnershipCache } from '@/lib/ownership';
import { dvaProcessingFee, round2 } from '@/lib/paystack-fees';
import { WalletService } from '../wallet.service';
import { toNumber, resolveTransactionDateForLockedMonth } from '@/shared/helpers';
import { eventBus } from '@/core/events/event-bus';
import { encrypt, computeBlindIndex } from '@/lib/crypto';

// ─── Process DVA Assignment Webhook ─────────────────────────

export async function processDVAAssignmentWebhook(event: any) {
  const eventType = event.event;
  const data = event.data;

  if (eventType === 'dedicatedaccount.assign.success') {
    const customerCode = data.customer?.customer_code;
    const accountNumber = data.dedicated_account?.account_number;
    const bankName = data.dedicated_account?.bank?.name;

    if (!customerCode || !accountNumber) {
      logger.warn('DVA webhook missing required fields', { eventType, data });
      return;
    }

    // Find business by customer code
    const business = await prisma.business.findFirst({
      where: { paystackCustomerCode: customerCode },
    });

    if (!business) {
      logger.warn('DVA webhook: no business found for customer code', { customerCode });
      return;
    }

    await prisma.business.update({
      where: { id: business.id },
      data: {
        virtualAccountNumber: accountNumber,
        virtualAccountBank: bankName || 'Wema Bank',
        dvaFailureReason: null,
        dvaFailedAt: null,
      },
    });

    await prisma.user.update({
      where: { id: business.userId },
      data: {
        virtualAccountNumber: accountNumber,
        virtualAccountBank: bankName || 'Wema Bank',
        paystackCustomerCode: customerCode,
      },
    });

    invalidateOwnershipCache(business.id, business.userId);

    logAudit({
      businessId: business.id,
      action: 'dva.assigned',
      resourceType: 'business',
      resourceId: business.id,
      newData: { accountNumber, bank: bankName },
    });

    logger.info('DVA assigned via webhook', { businessId: business.id, accountNumber });
  }

  if (eventType === 'dedicatedaccount.assign.failed') {
    const customerCode = data.customer?.customer_code;
    const reason = data.message || 'Dedicated account assignment failed';

    logger.error('DVA assignment failed', { customerCode, data });

    const business = customerCode
      ? await prisma.business.findFirst({ where: { paystackCustomerCode: customerCode } })
      : null;

    if (business) {
      await prisma.business.update({
        where: { id: business.id },
        data: { dvaFailureReason: reason, dvaFailedAt: new Date() },
      });
    }

    logAudit({
      businessId: business?.id,
      action: 'dva.failed',
      resourceType: 'business',
      resourceId: business?.id,
      newData: { customerCode, reason },
    });
  }
}

// ─── Process Customer Identification Webhook ────────────────

export async function processCustomerIdentificationWebhook(event: any) {
  const eventType = event.event;
  const data = event.data || {};
  const customerCode = data.customer_code || data.customer?.customer_code;

  if (!customerCode) {
    logger.warn('Customer identification webhook missing customer code', { eventType, data });
    return;
  }

  const business = await prisma.business.findFirst({
    where: { paystackCustomerCode: customerCode },
  });

  if (!business) {
    logger.warn('Customer identification webhook: no business for customer code', { customerCode });
    return;
  }

  if (eventType === 'customeridentification.success') {
    logger.info('Customer identification succeeded', { businessId: business.id, customerCode });

    logAudit({
      businessId: business.id,
      action: 'dva.customer_identified',
      resourceType: 'business',
      resourceId: business.id,
      newData: { customerCode },
    });

    await prisma.business.update({
      where: { id: business.id },
      data: { dvaFailureReason: null, dvaFailedAt: null },
    });

    const webhookBvn = data.bvn || data.identification?.number;
    await prisma.user.update({
      where: { id: business.userId },
      data: {
        bvnVerifiedAt: new Date(),
        ...(webhookBvn
          ? {
              bvn: encrypt(webhookBvn),
              bvnHash: computeBlindIndex(webhookBvn),
            }
          : {}),
      },
    });

    if (business.virtualAccountNumber) {
      logger.info('Identification success but DVA already assigned — skipping', {
        businessId: business.id,
      });
      return;
    }

    try {
      const provider = getPaymentProvider();
      const subaccount = business.paystackSubaccountCode || undefined;
      const dva = await provider.createDedicatedAccount(
        customerCode,
        config.paystack.preferredBank,
        subaccount,
      );

      if (dva.accountNumber) {
        await prisma.business.update({
          where: { id: business.id },
          data: {
            virtualAccountNumber: dva.accountNumber,
            virtualAccountBank: dva.bankName,
            dvaFailureReason: null,
            dvaFailedAt: null,
          },
        });

        logAudit({
          businessId: business.id,
          action: 'dva.assigned',
          resourceType: 'business',
          resourceId: business.id,
          newData: { accountNumber: dva.accountNumber, bank: dva.bankName, via: 'identification_webhook' },
        });

        logger.info('DVA assigned after identification success', {
          businessId: business.id,
          accountNumber: dva.accountNumber,
        });
      } else {
        logger.info('DVA requested after identification — awaiting assign webhook', {
          businessId: business.id,
        });
      }
    } catch (err) {
      logger.error('Failed to create DVA after identification success', {
        businessId: business.id,
        customerCode,
        err: err instanceof Error ? err.message : err,
      });
    }

    return;
  }

  if (eventType === 'customeridentification.failed') {
    const reason = data.reason || data.message || 'Identity verification failed';

    logger.error('Customer identification failed', { businessId: business.id, customerCode, reason });

    await prisma.business.update({
      where: { id: business.id },
      data: { dvaFailureReason: reason, dvaFailedAt: new Date() },
    });

    logAudit({
      businessId: business.id,
      action: 'dva.customer_identification_failed',
      resourceType: 'business',
      resourceId: business.id,
      newData: { customerCode, reason },
    });

    void createReminderOnce({
      businessId: business.id,
      reminderType: 'dva_validation_failed',
      scheduledDate: new Date(),
      message: `We couldn't verify your identity for your virtual account: ${reason}. Please check your BVN and that the bank account is in your name, then try again.`,
      referenceType: 'business',
      referenceId: customerCode,
      updateMessageOnDup: true,
    }).catch((err) =>
      logger.warn('Failed to create dva_validation_failed reminder', {
        businessId: business.id,
        err: err instanceof Error ? err.message : err,
      }),
    );
  }
}

// ─── Process DVA Transfer (Auto-Record Sale) ────────────────

export async function processDVATransferWebhook(event: any) {
  const data = event.data;
  const reference = data.reference;
  const amount = data.amount / 100; // kobo to naira
  const channel = data.channel;

  // Only handle dedicated_nuban transfers
  if (channel !== 'dedicated_nuban') return false;

  // If this transfer corresponds to a storefront order, skip generic DVA auto-capture
  // to avoid double-booking against the Storefront order fulfillment handler.
  if (reference && typeof reference === 'string' && reference.startsWith('ORD-')) {
    logger.info('DVA transfer corresponds to storefront order, skipping generic auto-capture', { reference });
    return false;
  }

  const accountNumber =
    data.authorization?.receiver_bank_account_number ||
    data.dedicated_account?.account_number ||
    data.metadata?.receiver_account_number;

  if (!accountNumber) {
    logger.warn('DVA transfer webhook missing account number', { reference });
    return false;
  }

  let business: any = null;

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { virtualAccountNumber: accountNumber },
        { businesses: { some: { virtualAccountNumber: accountNumber } } },
      ],
    },
    include: {
      businesses: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (user && user.businesses.length > 0) {
    business = user.primaryBusinessId
      ? user.businesses.find((b) => b.id === user.primaryBusinessId) || user.businesses[0]
      : user.businesses[0];
  }

  if (!business) {
    business = await prisma.business.findFirst({
      where: { virtualAccountNumber: accountNumber },
    });
  }

  if (!business) {
    logger.warn('DVA transfer: no business found for account', { accountNumber, reference });
    return false;
  }

  const existingSale = await prisma.salesTransaction.findFirst({
    where: { referenceId: reference, businessId: business.id },
  });

  const existingWalletTx = await prisma.walletTransaction.findUnique({
    where: { reference },
  });

  if (existingSale && existingWalletTx) {
    logger.info('DVA transfer already fully recorded and credited', { reference, businessId: business.id });
    return true;
  }

  const customerHint = 
    data.metadata?.purpose || 
    data.narration || 
    (data.customer?.first_name 
      ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim()
      : null);

  const isSplitSettled = Boolean(business.autoSplitEnabled && business.paystackSubaccountCode);
  const splitPct = isSplitSettled ? business.taxSplitPercentage : null;
  const platformRetained =
    isSplitSettled && business.taxSplitPercentage != null
      ? new Prisma.Decimal(amount).mul(business.taxSplitPercentage).div(100)
      : null;

  const feeNaira =
    typeof data.fees === 'number' ? round2(data.fees / 100) : dvaProcessingFee(amount);
  const netRetained =
    isSplitSettled && platformRetained
      ? toNumber(platformRetained)
      : Math.max(0, amount - feeNaira);

  // Self-healing path: sale was previously recorded but wallet crediting failed
  if (existingSale && !existingWalletTx) {
    logger.warn('DVA transfer sale exists but wallet credit is missing — executing healing credit', {
      reference,
      businessId: business.id,
      saleId: existingSale.id,
    });

    const walletTx = await WalletService.creditWallet({
      userId: business.userId,
      businessId: business.id,
      amount,
      fee: feeNaira,
      netAmount: netRetained,
      reference,
      source: 'dva',
      description: `DVA bank transfer from ${data.customer?.first_name || 'Customer'}`,
      linkedSaleId: existingSale.id,
      metadata: {
        channel: 'dva',
        paystackTransactionId: data.id,
        splitSettled: isSplitSettled,
        healed: true,
      },
    });

    eventBus.emit('wallet.credited', {
      userId: business.userId,
      businessId: business.id,
      amount,
      transactionId: walletTx.transaction.id,
    });

    return true;
  }

  // Standard atomic path: create both sale and wallet credit in one transaction fence
  try {
    const rawPaidDate = data.paid_at ? new Date(data.paid_at) : new Date();
    const dateRes = await resolveTransactionDateForLockedMonth(business.id, rawPaidDate, prisma);
    if (dateRes.wasAdjusted) {
      logger.warn('DVA transfer target month is locked/finalized — adjusting transactionDate to current open period', {
        businessId: business.id,
        reference,
        originalPaidAt: data.paid_at,
        effectiveDate: dateRes.effectiveDate.toISOString(),
        reason: dateRes.reason,
      });
    }

    const { sale, walletTx } = await prisma.$transaction(
      async (tx) => {
        const sale = await tx.salesTransaction.create({
          data: {
            businessId: business.id,
            amount,
            source: 'bank_transfer',
            dvaOrigin: true,
            status: 'pending',
            referenceId: reference,
            customerName: data.customer?.first_name
              ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim()
              : 'Bank Transfer',
            transactionDate: dateRes.effectiveDate,
            settledViaSplit: isSplitSettled,
            splitPct,
            platformRetained,
            metadata: {
              channel: 'dva',
              paystackTransactionId: data.id,
              autoRecorded: true,
              splitSettled: isSplitSettled,
              paystackFeeNaira: typeof data.fees === 'number' ? round2(data.fees / 100) : null,
              paystackFeeModelledNaira: dvaProcessingFee(amount),
              monthLockAdjusted: dateRes.wasAdjusted,
              ...(dateRes.wasAdjusted
                ? {
                    originalPaidAt: data.paid_at,
                    adjustmentReason: dateRes.reason,
                  }
                : {}),
            },
            needsVerification: true,
            customerHint,
            isTaxable: true,
          },
        });

        const walletTx = await WalletService.creditWallet(
          {
            userId: business.userId,
            businessId: business.id,
            amount,
            fee: feeNaira,
            netAmount: netRetained,
            reference,
            source: 'dva',
            description: `DVA bank transfer from ${data.customer?.first_name || 'Customer'}`,
            linkedSaleId: sale.id,
            metadata: {
              channel: 'dva',
              paystackTransactionId: data.id,
              splitSettled: isSplitSettled,
            },
          },
          tx
        );

        await logAudit(
          {
            businessId: business.id,
            action: 'sale.auto_captured',
            resourceType: 'sales_transaction',
            resourceId: sale.id,
            newData: {
              amount,
              reference,
              channel: 'dva',
              customerName: data.customer?.first_name,
              monthLockAdjusted: dateRes.wasAdjusted,
              transactionDate: dateRes.effectiveDate.toISOString(),
            },
          },
          tx
        );

        return { sale, walletTx };
      },
      { maxWait: 10000, timeout: 20000 }
    );

    logger.info('Sale auto-captured and wallet credited atomically from DVA transfer', {
      businessId: business.id,
      amount,
      reference,
      saleId: sale.id,
      walletTxId: walletTx.transaction.id,
    });

    eventBus.emit('dva.transfer_received', {
      accountNumber,
      amount,
      reference,
      payerName: data.customer?.first_name
        ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim()
        : undefined,
      rawEvent: event,
    });

    eventBus.emit('wallet.credited', {
      userId: business.userId,
      businessId: business.id,
      amount,
      transactionId: walletTx.transaction.id,
    });

    void createReminderOnce({
      businessId: business.id,
      reminderType: 'transaction_needs_verification',
      scheduledDate: new Date(),
      message: `New payment of ${formatNaira(amount)} received. Please verify the transaction.`,
      referenceType: 'sales_transaction',
      referenceId: sale.id,
    }).catch((err) =>
      logger.warn('Failed to create transaction_needs_verification reminder', {
        saleId: sale.id,
        err: err instanceof Error ? err.message : err,
      })
    );

    return true;
  } catch (err: any) {
    if (err.code === 'P2002') {
      logger.info('Concurrent DVA transfer already recorded', { reference, businessId: business.id });
      return true;
    }
    logger.error('Failed to process DVA transfer webhook atomically', {
      reference,
      err: err instanceof Error ? err.message : err,
    });
    throw err;
  }
}
