import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { config } from '@/config';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { getPaymentProvider } from '@/lib/payment';
import { createReminderOnce } from '@/services/reminder.service';
import { formatNaira } from '@/lib/format';
import { verifyBusinessOwnership } from '@/lib/ownership';

// ─── Helpers ────────────────────────────────────────────────

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] || 'Business';
  const lastName = parts.slice(1).join(' ') || 'Owner';
  return { firstName, lastName };
}

// ─── Validate Customer (BVN + bank account) ──────────────────
//
// Paystack moved off the deprecated `type: 'bvn'` validation shape to
// `type: 'bank_account'` — they now cross-check the BVN against a bank
// account registered under the same NIBSS record. The caller MUST supply
// both the bank's NIBSS clearing code (e.g. "044" for Access) and the
// 10-digit NUBAN account number alongside the BVN. The bank list comes
// from `GET /api/v1/banks` (cached `bank.service.ts`); the BVN form on
// Account.tsx renders a dropdown sourced from that endpoint.
//
// Validation is asynchronous on Paystack's side — they queue the check
// and emit `customeridentification.success` / `customeridentification.failed`
// webhooks (not yet handled — see plan Phase 4.1). For now we return
// `validated: true` to mean "submission accepted" and tell the user to
// retry DVA setup in a few moments.

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

  // Store BVN and NIN on User record after successful Paystack validation
  await prisma.user.update({
    where: { id: userId },
    data: {
      bvn: input.bvn,
      nin: input.nin || undefined,
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
    // We DELIBERATELY do not log the BVN or full account number — both are
    // PII. Last-4 of the account is enough for support traceability.
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

  // Paystack rejects fintech-DVA customer creation when the upstream record
  // has no phone — `customeridentification.failed` fires later with a vague
  // "phone required" message that's hostile to surface to the SME. Block at
  // the door instead so the UI can inline-capture the missing field, PATCH
  // /auth/me, and retry setup. Frontend Account.tsx catches this code and
  // renders the inline phone form. Path (b) from paymentPlan.md §2.3 —
  // intentionally NOT enforced at registration so users who never want a
  // DVA aren't gated on phone collection.
  if (!user.phone || !user.phone.trim()) {
    throw new AppError(
      400,
      'Add your phone number before setting up a virtual account. Paystack requires it for identity verification.',
      'USER_PHONE_REQUIRED',
    );
  }

  const provider = getPaymentProvider();
  const { firstName, lastName } = splitName(business.ownerName);

  // Step 1: Create Paystack customer (or reuse existing).
  //
  // Returns the code we should pass to /dedicated_account. Persists newly
  // created codes to the business row. Reused as the retry path below when
  // a stale code triggers customer_not_found.
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

  // Step 2: Request dedicated virtual account.
  //
  // NOTE: On live mode, Paystack requires customer BVN validation before DVA.
  // If Paystack returns an error about validation, we surface it clearly.
  //
  // Self-heal on stale customer_code: if the code we have was created against
  // a different Paystack integration (e.g. test→live swap, or restored from a
  // backup with another team's data), Paystack returns customer_not_found.
  // Recreate the customer once against the current key and retry. If the
  // retry also fails, let the original AppError propagate to the caller.
  // Bank slug is mode-aware (test-bank in test mode, wema-bank in live). See
  // config.paystack.preferredBank — env var PAYSTACK_PREFERRED_BANK overrides.
  const preferredBank = config.paystack.preferredBank;
  const subaccount = business.paystackSubaccountCode || undefined;

  // Normalize Paystack's "needs BVN validation" error to the stable
  // `validation_required` code the frontend (Account.tsx handleSetup) keys on
  // to open the BVN form. Test mode returns the `validation_required` code
  // directly, but LIVE mode rejects DVA creation with the message
  // "Customer has not been identified" and a different/empty code — which
  // previously fell through to a generic toast and dead-ended the user. We
  // match on the message text (case-insensitive) and re-throw with the code
  // the UI already handles, so both modes drive the same BVN-form path.
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

  // If Paystack returned account details synchronously, save them now
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

  // Surfaces a `customeridentification.failed` / `dedicatedaccount.assign.failed`
  // webhook that landed since the last check. Without this, the frontend's
  // poll only ever sees 'none' — identical to "never started" — and has no
  // way to distinguish "still processing" from "already failed", so it just
  // spins until its own client-side timeout regardless of what actually
  // happened on Paystack's side.
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
//
// IMPORTANT: this is NOT a live query against Paystack. Paystack does not
// expose a running balance for a specific dedicated account — a transfer
// either has already generated a charge.success (and therefore a row in
// our own SalesTransaction table via processDVATransferWebhook), or it
// hasn't happened yet. There is nothing else to ask Paystack for. This
// endpoint summarizes OUR OWN records, which is the only "balance" that
// actually exists for a DVA under split-settlement.
//
// Two totals on purpose: `confirmed` only counts sales a human has verified
// (see POST /sales/:id/verify) and is what feeds tax calculations. Every
// DVA transfer lands in `pendingVerification` first — see the explicit
// `status: 'pending', needsVerification: true` inside the
// prisma.salesTransaction.create() call in processDVATransferWebhook below.
// A transaction sitting only in pendingVerification is real money that has
// already settled to the business's bank — it just hasn't been confirmed
// as taxable revenue yet.

export async function getDVABalance(userId: string, businessId: string) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // Scoped to DVA-originated transactions specifically — source alone
  // ('bank_transfer') would also catch manually-logged bank transfer sales
  // that a user entered by hand via POST /sales, which aren't DVA money.
  const dvaFilter = {
    businessId: business.id,
    source: 'bank_transfer' as const,
    metadata: { path: ['channel'], equals: 'dva' },
  };

  const [confirmed, pending, lastTransaction] = await Promise.all([
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

  return {
    accountNumber: business.virtualAccountNumber,
    accountStatus: business.virtualAccountNumber ? 'active' : 'none',
    confirmed: {
      total: confirmed._sum.amount ?? 0,
      count: confirmed._count,
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

    // Previously this branch never looked up the business, so the failure
    // was only ever visible in logs/audit — never surfaced to the SME via
    // GET /dva/virtual-account. Mirrors the success branch's lookup so the
    // frontend poll can stop spinning and show the real reason.
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
//
// Live-mode DVA creation is gated on BVN identity validation, which Paystack
// processes ASYNCHRONOUSLY after `POST /customer/:code/identification` (our
// validateCustomer). It then emits one of these terminal events:
//
//   customeridentification.success — BVN matched. We now request the DVA
//     (Wema/Titan) on the SME's behalf so the account just appears without
//     them having to click "Set Up" again.
//   customeridentification.failed  — BVN/account-name mismatch (or similar).
//     We capture the reason on a `dva_validation_failed` reminder so the SME
//     finally sees WHY (previously invisible — the gap that left setup stuck
//     in a silent retry loop).
//
// Idempotent: success re-creates the DVA via createDedicatedAccount, which
// short-circuits in setupVirtualAccount-style guards isn't reused here — but
// Paystack itself returns the existing account if one already exists, and we
// no-op when virtualAccountNumber is already stored.
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

    // Identification succeeded — clear any prior failure record so a stale
    // reason from an earlier attempt doesn't linger on the business row.
    await prisma.business.update({
      where: { id: business.id },
      data: { dvaFailureReason: null, dvaFailedAt: null },
    });

    // Already has a DVA — nothing to do (a re-validation or replayed webhook).
    if (business.virtualAccountNumber) {
      logger.info('Identification success but DVA already assigned — skipping', {
        businessId: business.id,
      });
      return;
    }

    // Request the dedicated account now that identity is confirmed. Mirrors
    // the createDedicatedAccount call in setupVirtualAccount (same bank slug +
    // optional subaccount split). If Paystack returns the account
    // synchronously we persist it; otherwise the dedicatedaccount.assign.success
    // webhook will land shortly and processDVAAssignmentWebhook stores it.
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

    // Persist so GET /dva/virtual-account can report `status: 'failed'` with
    // the reason instead of the frontend polling forever with no signal.
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

    // Surface the reason to the SME via the bell. referenceId = customerCode
    // dedupes repeated failures for the same customer to a single reminder row
    // (whose message refreshes with the latest reason).
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

  // Find the virtual account number from the transaction.
  // `authorization.receiver_bank_account_number` is the field real Paystack
  // charge.success payloads use for DVA transfers — checked first. The other
  // two are kept as fallbacks in case Paystack's shape varies, but this order
  // has NOT been confirmed against a live payload yet. First thing to do:
  // log one real test-mode transfer's raw body and confirm which path hits.
  const accountNumber =
    data.authorization?.receiver_bank_account_number ||
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
  // Extract customer hint from metadata or narration
  const customerHint = 
    data.metadata?.purpose || 
    data.narration || 
    (data.customer?.first_name 
      ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim()
      : null);

  const sale = await prisma.salesTransaction.create({
    data: {
      businessId: business.id,
      amount,
      source: 'bank_transfer',
      status: 'pending',
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
      needsVerification: true,
      customerHint,
      isTaxable: true,
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

  // Rate limit check
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
  // ...

  logger.info('DVA requeried', { businessId, userId, transactionCount });

  return {
    accountNumber: result.accountNumber,
    transactionCount,
    message: 'DVA requeried successfully. Any missing transfers should appear shortly.',
  };
}



// ─── Settlement Bank Connection (Subaccount Split-Settlement) ────────────────

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

export async function connectSettlementBank(
  userId: string,
  businessId: string,
  params: { bankCode: string; bankName: string; accountNumber: string; commissionPct?: number },
) {
  const business = await verifyBusinessOwnership(userId, businessId);
  const provider = getPaymentProvider();

  // Re-resolve server-side (never trust client-supplied name)
  const { accountName } = await provider.resolveAccount(params.accountNumber, params.bankCode);

  const { subaccountCode } = await provider.createSubaccount({
    businessName: business.businessName,
    bankCode: params.bankCode,
    accountNumber: params.accountNumber,
    percentageCharge: params.commissionPct ?? 0,
  });

  await prisma.business.update({
    where: { id: businessId },
    data: {
      paystackSubaccountCode: subaccountCode,
      settlementBankCode: params.bankCode,
      settlementBankName: params.bankName,
      settlementAccountNumber: params.accountNumber,
      settlementAccountName: accountName,
      platformCommissionPct: params.commissionPct ?? 0,
      settlementConnectedAt: new Date(),
    },
  });

  // Retrofit: if a DVA already exists, it was created WITHOUT this subaccount,
  // so inbound money is still pooling in the platform balance instead of
  // settling to the SME's bank. Attach the split now so it starts settling.
  // New DVAs (set up after this point) are born attached via setupVirtualAccount.
  //
  // Wrapped so a split-attach failure never loses the already-saved subaccount —
  // the SME can retry attach via re-connecting, or a new DVA setup will attach
  // it natively. `splitAttached` lets the caller surface a soft warning.
  let splitAttached = false;
  if (business.virtualAccountNumber && business.paystackCustomerCode) {
    try {
      await provider.splitDedicatedAccount(business.paystackCustomerCode, subaccountCode);
      splitAttached = true;
      logger.info('Subaccount split attached to existing DVA', {
        businessId,
        subaccountCode,
      });
    } catch (err) {
      logger.error('Failed to attach subaccount split to existing DVA', {
        businessId,
        subaccountCode,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  logAudit({
    userId,
    businessId,
    action: 'settlement.connected',
    resourceType: 'business',
    resourceId: businessId,
    newData: { subaccountCode, bankCode: params.bankCode, accountLast4: params.accountNumber.slice(-4), splitAttached },
  });

  return { subaccountCode, accountName, bankName: params.bankName, splitAttached };
}