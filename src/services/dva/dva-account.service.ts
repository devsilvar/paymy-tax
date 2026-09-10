import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { config } from '@/config';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { verifyBusinessOwnership, invalidateOwnershipCache } from '@/lib/ownership';
import { SetupVirtualAccountInput } from '@/validators/dva.validator';
import { encrypt, computeBlindIndex } from '@/lib/crypto';

// ─── Helpers ────────────────────────────────────────────────

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] || 'Business';
  const lastName = parts.slice(1).join(' ') || 'Owner';
  return { firstName, lastName };
}

// ─── Validate Customer (BVN + bank account) ──────────────────

export interface ValidateCustomerInput {
  bvn: string;
  nin?: string;
  bankCode: string;
  accountNumber: string;
}

export async function validateCustomer(
  userId: string,
  businessId: string,
  input: ValidateCustomerInput,
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  if (!business.paystackCustomerCode) {
    throw new AppError(
      400,
      'No Paystack customer exists for this business. Set up virtual account first.',
      'NO_CUSTOMER',
    );
  }

  // Pre-check BVN uniqueness across other user accounts using blind index
  const bvnHash = computeBlindIndex(input.bvn);
  const existing = await prisma.user.findFirst({
    where: { bvnHash, id: { not: userId } },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, 'This BVN is already linked to another account', 'BVN_ALREADY_LINKED');
  }

  const provider = getPaymentProvider();
  const { firstName, lastName } = splitName(business.ownerName);

  await provider.validateCustomer({
    customerCode: business.paystackCustomerCode,
    bvn: input.bvn,
    bankCode: input.bankCode,
    accountNumber: input.accountNumber,
    firstName,
    lastName,
  });

  // Store encrypted BVN and NIN on User record after successful Paystack validation
  await prisma.user.update({
    where: { id: userId },
    data: {
      bvn: encrypt(input.bvn),
      bvnHash,
      nin: input.nin ? encrypt(input.nin) : undefined,
      ninHash: input.nin ? computeBlindIndex(input.nin) : undefined,
      bvnVerifiedAt: new Date(),
      ninVerifiedAt: input.nin ? new Date() : undefined,
    },
  });

  // A new attempt is now in flight with Paystack — clear any stale failure
  // from a previous attempt so the UI doesn't show a leftover error while
  // this submission is being processed.
  await prisma.business.update({
    where: { id: businessId },
    data: { dvaFailureReason: null, dvaFailedAt: null },
  });

  logAudit({
    userId,
    businessId,
    action: 'dva.customer_validated',
    resourceType: 'business',
    resourceId: businessId,
    newData: {
      bankCode: input.bankCode,
      accountLast4: input.accountNumber.slice(-4),
      ninProvided: !!input.nin,
    },
  });

  logger.info('Customer BVN+bank validation submitted', {
    businessId,
    customerCode: business.paystackCustomerCode,
  });

  return { validated: true };
}

// ─── Setup Virtual Account ──────────────────────────────────

export async function setupVirtualAccount(
  userId: string,
  businessId: string,
  input?: SetupVirtualAccountInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // If BVN is supplied during onboarding, persist and verify on User record
  if (input?.bvn) {
    const bvnHash = computeBlindIndex(input.bvn);
    const existing = await prisma.user.findFirst({
      where: { bvnHash, id: { not: userId } },
      select: { id: true },
    });

    if (existing) {
      throw new AppError(409, 'This BVN is already linked to another account', 'BVN_ALREADY_LINKED');
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        bvn: encrypt(input.bvn),
        bvnHash,
        nin: input.nin ? encrypt(input.nin) : undefined,
        ninHash: input.nin ? computeBlindIndex(input.nin) : undefined,
        bvnVerifiedAt: new Date(),
        ninVerifiedAt: input.nin ? new Date() : undefined,
      },
    });

    logAudit({
      userId,
      businessId,
      action: 'user.bvn_stored_onboarding',
      resourceType: 'user_security',
      resourceId: userId,
      newData: { bvnLast4: input.bvn.slice(-4), bvnVerifiedAt: new Date().toISOString() },
    });

    logger.info('User BVN stored during DVA onboarding', {
      userId,
      bvnLast4: input.bvn.slice(-4),
    });
  }

  // Check if DVA already exists
  if (business.virtualAccountNumber) {
    return {
      status: 'active' as const,
      accountNumber: business.virtualAccountNumber,
      bankName: business.virtualAccountBank,
    };
  }

  // Get user for email/phone/central DVA
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      phone: true,
      virtualAccountNumber: true,
      virtualAccountBank: true,
      paystackCustomerCode: true,
      primaryBusinessId: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  // If user already has a central virtual account, attach it to this business immediately
  if (user.virtualAccountNumber) {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        virtualAccountNumber: user.virtualAccountNumber,
        virtualAccountBank: user.virtualAccountBank,
        paystackCustomerCode: user.paystackCustomerCode,
        dvaFailureReason: null,
        dvaFailedAt: null,
      },
    });

    invalidateOwnershipCache(businessId, userId);

    return {
      status: 'active' as const,
      accountNumber: user.virtualAccountNumber,
      bankName: user.virtualAccountBank || 'Wema Bank',
    };
  }

  if (!user.phone || !user.phone.trim()) {
    throw new AppError(
      400,
      'Add your phone number before setting up a virtual account. Paystack requires it for identity verification.',
      'USER_PHONE_REQUIRED',
    );
  }

  const provider = getPaymentProvider();
  const { firstName, lastName } = splitName(business.ownerName);

  const ensureCustomerCode = async (force = false): Promise<string> => {
    if (!force && business.paystackCustomerCode) {
      return business.paystackCustomerCode;
    }

    const customer = await provider.createCustomer({
      email: user.email,
      firstName,
      lastName,
      phone: user.phone || undefined,
    });

    await prisma.business.update({
      where: { id: businessId },
      data: { paystackCustomerCode: customer.customerCode },
    });

    logger.info('Paystack customer created', {
      businessId,
      customerCode: customer.customerCode,
      recreated: force,
    });

    return customer.customerCode;
  };

  let customerCode = await ensureCustomerCode();

  const preferredBank = config.paystack.preferredBank;
  const subaccount = business.paystackSubaccountCode || undefined;

  const normalizeValidationError = (err: unknown): never => {
    if (err instanceof AppError && err.code === 'PAYSTACK_ERROR') {
      const paystackCode = (err.details as { paystackCode?: string } | undefined)?.paystackCode;
      const needsIdentification =
        paystackCode === 'validation_required' ||
        /not been identified|customer.*not.*identified/i.test(err.message);

      if (needsIdentification) {
        throw new AppError(
          400,
          'Paystack requires your BVN and a bank account in your name before issuing a virtual account.',
          'PAYSTACK_ERROR',
          { paystackCode: 'validation_required', type: 'validation' },
        );
      }
    }
    throw err;
  };

  let dva;
  try {
    dva = await provider.createDedicatedAccount(customerCode, preferredBank, subaccount);
  } catch (err) {
    const isStaleCode =
      err instanceof AppError &&
      err.code === 'PAYSTACK_ERROR' &&
      (err.details as { paystackCode?: string } | undefined)?.paystackCode === 'customer_not_found';

    if (!isStaleCode) normalizeValidationError(err);

    logger.warn('Stale Paystack customer code detected — recreating', {
      businessId,
      staleCustomerCode: customerCode,
    });

    customerCode = await ensureCustomerCode(true);
    try {
      dva = await provider.createDedicatedAccount(customerCode, preferredBank, subaccount);
    } catch (retryErr) {
      normalizeValidationError(retryErr);
    }
  }

  if (dva.accountNumber) {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        virtualAccountNumber: dva.accountNumber,
        virtualAccountBank: dva.bankName,
        dvaFailureReason: null,
        dvaFailedAt: null,
      },
    });

    await prisma.user.update({
      where: { id: userId },
      data: {
        virtualAccountNumber: dva.accountNumber,
        virtualAccountBank: dva.bankName,
        paystackCustomerCode: customerCode,
        primaryBusinessId: businessId,
      },
    });

    invalidateOwnershipCache(businessId, userId);

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
      bankName: business.virtualAccountBank || 'Wema Bank',
      accountName: business.ownerName,
      businessName: business.businessName,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { virtualAccountNumber: true, virtualAccountBank: true, paystackCustomerCode: true },
  });

  if (user?.virtualAccountNumber) {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        virtualAccountNumber: user.virtualAccountNumber,
        virtualAccountBank: user.virtualAccountBank,
        paystackCustomerCode: user.paystackCustomerCode,
      },
    });
    invalidateOwnershipCache(businessId, userId);

    return {
      status: 'active',
      accountNumber: user.virtualAccountNumber,
      bankName: user.virtualAccountBank || 'Wema Bank',
      accountName: business.ownerName,
      businessName: business.businessName,
    };
  }

  if (business.dvaFailureReason) {
    return {
      status: 'failed',
      message: business.dvaFailureReason,
      failedAt: business.dvaFailedAt,
    };
  }

  return {
    status: 'none',
    message: 'No virtual account set up for this business.',
  };
}

// ─── Get DVA Balance / Transaction Summary ──────────────────

export async function getDVABalance(userId: string, businessId: string) {
  const business = await verifyBusinessOwnership(userId, businessId);

  const dvaFilter = {
    businessId: business.id,
    source: 'bank_transfer' as const,
    dvaOrigin: true,
  };

  const [completed, pending, lastTransaction] = await Promise.all([
    prisma.salesTransaction.aggregate({
      where: { ...dvaFilter, status: 'confirmed' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.salesTransaction.aggregate({
      where: { ...dvaFilter, needsVerification: true },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.salesTransaction.findFirst({
      where: dvaFilter,
      orderBy: { transactionDate: 'desc' },
      select: { amount: true, transactionDate: true, status: true },
    }),
  ]);

  const resolvedAccountNum =
    business.virtualAccountNumber ||
    (await prisma.user.findUnique({
      where: { id: userId },
      select: { virtualAccountNumber: true },
    }))?.virtualAccountNumber;

  return {
    accountNumber: resolvedAccountNum,
    accountStatus: resolvedAccountNum ? 'active' : 'none',
    completed: {
      total: completed._sum.amount ?? 0,
      count: completed._count,
    },
    pendingVerification: {
      total: pending._sum.amount ?? 0,
      count: pending._count,
    },
    lastTransaction: lastTransaction
      ? {
          amount: lastTransaction.amount,
          date: lastTransaction.transactionDate,
          status: lastTransaction.status,
        }
      : null,
    note: 'confirmed = verified sales that count toward tax. pendingVerification = money already received via the DVA but awaiting confirmation at POST /sales/:id/verify. This is computed from our own records, not a live Paystack balance check.',
  };
}

// ─── Requery DVA ────────────────────────────────────────────

const lastRequeryTimes = new Map<string, number>();
const REQUERY_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes

export async function requeryDVA(userId: string, businessId: string) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { user: true },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  if (!business.virtualAccountNumber) {
    throw new AppError(400, 'No virtual account set up for this business', 'NO_DVA');
  }

  const now = Date.now();
  const lastRequery = lastRequeryTimes.get(businessId);
  if (lastRequery && now - lastRequery < REQUERY_RATE_LIMIT_MS) {
    const waitMinutes = Math.ceil((REQUERY_RATE_LIMIT_MS - (now - lastRequery)) / 60000);
    throw new AppError(
      429,
      `Please wait ${waitMinutes} more minutes before requerying`,
      'RATE_LIMITED'
    );
  }

  const provider = getPaymentProvider();
  const result = await provider.requeryDVA(
    business.virtualAccountNumber,
    config.paystack.preferredBank
  );

  lastRequeryTimes.set(businessId, now);

  const transactionCount = result.transactions?.length ?? 0;

  logAudit({
    userId,
    businessId,
    action: 'dva.requeried',
    resourceType: 'business',
    resourceId: businessId,
    newData: { transactionCount },
  });

  logger.info('DVA requeried', { businessId, userId, transactionCount });

  return {
    accountNumber: result.accountNumber,
    transactionCount,
    message: 'DVA requeried successfully. Any missing transfers should appear shortly.',
  };
}

// ─── Settlement Bank Connection ─────────────────────────────

export async function resolveSettlementAccount(
  userId: string,
  businessId: string,
  bankCode: string,
  accountNumber: string,
) {
  await verifyBusinessOwnership(userId, businessId);
  const provider = getPaymentProvider();

  logger.info('Resolving settlement account', { bankCode, accountNumber });
  const result = await provider.resolveAccount(accountNumber, bankCode);

  return {
    bankCode: result.bankCode,
    accountNumber: result.accountNumber,
    accountName: result.accountName,
  };
}

// ─── DVA Transactions Listing ───────────────────────────────

export async function getDVATransactions(
  userId: string,
  businessId: string,
  query: { page?: number; limit?: number; status?: string }
) {
  await verifyBusinessOwnership(userId, businessId);

  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const skip = (page - 1) * limit;

  const where: any = {
    businessId,
    source: 'bank_transfer',
    dvaOrigin: true,
  };

  if (query.status === 'confirmed') {
    where.status = 'confirmed';
    where.needsVerification = false;
  } else if (query.status === 'pending') {
    where.needsVerification = true;
  }

  const [total, transactions] = await Promise.all([
    prisma.salesTransaction.count({ where }),
    prisma.salesTransaction.findMany({
      where,
      orderBy: { transactionDate: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        amount: true,
        status: true,
        referenceId: true,
        customerName: true,
        customerHint: true,
        transactionDate: true,
        needsVerification: true,
        verifiedAt: true,
        createdAt: true,
        metadata: true,
      },
    }),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}
