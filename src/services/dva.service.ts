import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';

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

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] || 'Business';
  const lastName = parts.slice(1).join(' ') || 'Owner';
  return { firstName, lastName };
}

// ─── Validate Customer (BVN) ────────────────────────────────

export async function validateCustomer(userId: string, businessId: string, bvn: string) {
  const business = await verifyBusinessOwnership(userId, businessId);

  if (!business.paystackCustomerCode) {
    throw new AppError(400, 'No Paystack customer exists for this business. Set up virtual account first.', 'NO_CUSTOMER');
  }

  const provider = getPaymentProvider();
  const { firstName, lastName } = splitName(business.ownerName);

  await provider.validateCustomer({
    customerCode: business.paystackCustomerCode,
    bvn,
    firstName,
    lastName,
  });

  logAudit({
    userId,
    businessId,
    action: 'dva.customer_validated',
    resourceType: 'business',
    resourceId: businessId,
  });

  logger.info('Customer BVN validation submitted', { businessId, customerCode: business.paystackCustomerCode });

  return { validated: true };
}

// ─── Setup Virtual Account ──────────────────────────────────

export async function setupVirtualAccount(userId: string, businessId: string) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // Check if DVA already exists
  if (business.virtualAccountNumber) {
    return {
      status: 'active' as const,
      accountNumber: business.virtualAccountNumber,
      bankName: business.virtualAccountBank,
    };
  }

  // Get user for email/phone
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, phone: true },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const provider = getPaymentProvider();
  const { firstName, lastName } = splitName(business.ownerName);

  // Step 1: Create Paystack customer (or reuse existing)
  let customerCode = business.paystackCustomerCode;

  if (!customerCode) {
    const customer = await provider.createCustomer({
      email: user.email,
      firstName,
      lastName,
      phone: user.phone || undefined,
    });

    customerCode = customer.customerCode;

    await prisma.business.update({
      where: { id: businessId },
      data: { paystackCustomerCode: customerCode },
    });

    logger.info('Paystack customer created', { businessId, customerCode });
  }

  // Step 2: Request dedicated virtual account
  // NOTE: On live mode, Paystack requires customer BVN validation before DVA.
  // If Paystack returns an error about validation, we surface it clearly.
  const dva = await provider.createDedicatedAccount(customerCode);

  // If Paystack returned account details synchronously, save them now
  if (dva.accountNumber) {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        virtualAccountNumber: dva.accountNumber,
        virtualAccountBank: dva.bankName,
      },
    });

    logAudit({
      userId,
      businessId,
      action: 'dva.assigned',
      resourceType: 'business',
      resourceId: businessId,
      newData: { accountNumber: dva.accountNumber, bank: dva.bankName },
    });

    logger.info('DVA assigned synchronously', { businessId, accountNumber: dva.accountNumber });

    return {
      status: 'active' as const,
      accountNumber: dva.accountNumber,
      bankName: dva.bankName,
    };
  }

  // If async, Paystack will send webhook later
  logAudit({
    userId,
    businessId,
    action: 'dva.requested',
    resourceType: 'business',
    resourceId: businessId,
    newData: { customerCode },
  });

  logger.info('DVA requested (async)', { businessId, customerCode });

  return {
    status: 'pending' as const,
    message: 'Your account number is being set up. This usually takes a few seconds to a minute.',
  };
}

// ─── Get Virtual Account Details ────────────────────────────

export async function getVirtualAccount(userId: string, businessId: string) {
  const business = await verifyBusinessOwnership(userId, businessId);

  if (business.virtualAccountNumber) {
    return {
      status: 'active',
      accountNumber: business.virtualAccountNumber,
      bankName: business.virtualAccountBank,
    };
  }

  return {
    status: 'none',
    message: 'No virtual account set up for this business.',
  };
}

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
      },
    });

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

    logger.error('DVA assignment failed', { customerCode, data });

    logAudit({
      action: 'dva.failed',
      resourceType: 'business',
      newData: { customerCode, reason: data.message || 'Unknown' },
    });
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

  // Find the virtual account number from the transaction
  const accountNumber =
    data.dedicated_account?.account_number ||
    data.metadata?.receiver_account_number;

  if (!accountNumber) {
    logger.warn('DVA transfer webhook missing account number', { reference });
    return false;
  }

  // Find business by virtual account number
  const business = await prisma.business.findFirst({
    where: { virtualAccountNumber: accountNumber },
  });

  if (!business) {
    logger.warn('DVA transfer: no business found for account', { accountNumber, reference });
    return false;
  }

  // Check for duplicate (same reference)
  const existing = await prisma.salesTransaction.findFirst({
    where: { referenceId: reference, businessId: business.id },
  });

  if (existing) {
    logger.info('DVA transfer already recorded', { reference, businessId: business.id });
    return true;
  }

  // Auto-create sales transaction
  const sale = await prisma.salesTransaction.create({
    data: {
      businessId: business.id,
      amount,
      source: 'bank_transfer',
      status: 'confirmed',
      referenceId: reference,
      customerName: data.customer?.first_name
        ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim()
        : 'Bank Transfer',
      transactionDate: data.paid_at ? new Date(data.paid_at) : new Date(),
      metadata: {
        channel: 'dva',
        paystackTransactionId: data.id,
        autoRecorded: true,
      },
    },
  });

  logAudit({
    businessId: business.id,
    action: 'sale.auto_captured',
    resourceType: 'sales_transaction',
    resourceId: sale.id,
    newData: { amount, reference, channel: 'dva', customerName: data.customer?.first_name },
  });

  logger.info('Sale auto-captured from DVA transfer', {
    businessId: business.id,
    amount,
    reference,
  });

  // Fire-and-forget reminder. Replayed webhooks short-circuit at the
  // duplicate-check above, so this only fires once per real sale.
  void createReminderOnce({
    businessId: business.id,
    reminderType: 'dva_received',
    scheduledDate: new Date(),
    message: `We auto-captured a sale of ${formatNaira(amount)} from your virtual account.`,
    referenceType: 'sales_transaction',
    referenceId: sale.id,
  }).catch((err) =>
    logger.warn('Failed to create dva_received reminder', {
      saleId: sale.id,
      err: err instanceof Error ? err.message : err,
    })
  );

  return true;
}
