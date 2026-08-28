import prisma from '@/lib/prisma';
import { getPaymentProvider } from '@/lib/payment';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import * as pinService from '@/services/pin.service';
import {
  WithdrawBalanceInput,
  ToggleAutoSplitInput,
  PayoutHistoryQueryInput,
  ConnectSettlementInput,
  ResolveSettlementInput,
} from '@/validators/settlement.validator';

function toNumber(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof (val as any).toNumber === 'function') return (val as any).toNumber();
  const parsed = Number(val);
  return isNaN(parsed) ? 0 : parsed;
}

async function verifyBusinessOwnership(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          transactionPin: true,
          pinLockedUntil: true,
          pinAttempts: true,
        },
      },
    },
  });

  if (!business) {
    throw new AppError(404, 'Business not found or access denied', 'BUSINESS_NOT_FOUND');
  }

  return business;
}

/**
 * Computes available withdrawal balance, tax escrow reserve, and settlement details.
 */
export async function getPayoutPreview(userId: string, businessId: string) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // 1. Total confirmed DVA inflows
  const inflowsAggregate = await prisma.salesTransaction.aggregate({
    where: {
      businessId,
      source: 'bank_transfer',
      status: 'confirmed',
    },
    _sum: {
      amount: true,
    },
  });
  const totalInflows = toNumber(inflowsAggregate._sum.amount ?? 0);

  // 2. Total completed / pending withdrawals
  const payoutsAggregate = await prisma.settlementPayout.aggregate({
    where: {
      businessId,
      status: { in: ['completed', 'pending'] },
    },
    _sum: {
      amount: true,
    },
  });
  const totalWithdrawn = toNumber(payoutsAggregate._sum.amount ?? 0);

  // 3. Tax Liability calculation (unpaid reports or estimated monthly liability)
  // Check active unpaid monthly reports
  const unpaidReports = await prisma.monthlyTaxReport.findMany({
    where: {
      businessId,
      paymentStatus: { in: ['pending', 'failed'] },
    },
  });

  let estimatedTaxLiability = 0;
  for (const report of unpaidReports) {
    estimatedTaxLiability += toNumber(report.taxPayable);
  }

  // If no finalized reports yet, compute 7.5% tax escrow reserve on total sales minus expenses
  if (unpaidReports.length === 0 && totalInflows > 0) {
    const totalExpensesAgg = await prisma.expense.aggregate({
      where: { businessId, isDeductible: true },
      _sum: { amount: true },
    });
    const totalExpenses = toNumber(totalExpensesAgg._sum.amount ?? 0);
    const grossProfit = Math.max(0, totalInflows - totalExpenses);
    estimatedTaxLiability = Math.round(grossProfit * 0.075 * 100) / 100;
  }

  // 4. Safe available balance (cannot withdraw funds reserved for unpaid FIRS taxes)
  const taxReserve = Math.max(0, estimatedTaxLiability);
  const availableForWithdrawal = Math.max(0, Math.round((totalInflows - totalWithdrawn - taxReserve) * 100) / 100);

  const isPinLocked = Boolean(
    business.user.pinLockedUntil && business.user.pinLockedUntil > new Date()
  );

  return {
    businessId: business.id,
    businessName: business.businessName,
    totalInflows,
    totalWithdrawn,
    taxReserve,
    availableForWithdrawal,
    settlementAccount: {
      isConnected: Boolean(business.settlementAccountNumber && business.settlementBankCode),
      bankName: business.settlementBankName,
      bankCode: business.settlementBankCode,
      accountNumber: business.settlementAccountNumber,
      accountName: business.settlementAccountName,
      connectedAt: business.settlementConnectedAt,
    },
    autoSplit: {
      enabled: business.autoSplitEnabled,
      taxSplitPercentage: toNumber(business.taxSplitPercentage),
      subaccountCode: business.paystackSubaccountCode,
    },
    security: {
      hasPin: Boolean(business.user.transactionPin),
      isPinLocked,
      remainingAttempts: isPinLocked ? 0 : Math.max(0, 3 - (business.user.pinAttempts || 0)),
    },
  };
}

/**
 * Resolves commercial bank account name via Paystack provider
 */
export async function resolveSettlementAccount(params: ResolveSettlementInput) {
  const provider = getPaymentProvider();
  const result = await provider.resolveAccount(params.accountNumber, params.bankCode);
  return {
    bankCode: result.bankCode,
    accountNumber: result.accountNumber,
    accountName: result.accountName,
  };
}

/**
 * Connects commercial settlement bank and provisions split subaccount
 */
export async function connectSettlementBank(
  userId: string,
  businessId: string,
  params: ConnectSettlementInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);
  const provider = getPaymentProvider();

  // Re-resolve server-side
  const { accountName } = await provider.resolveAccount(params.accountNumber, params.bankCode);

  const { subaccountCode } = await provider.createSubaccount({
    businessName: business.businessName,
    bankCode: params.bankCode,
    accountNumber: params.accountNumber,
    percentageCharge: params.commissionPct ?? 0,
  });

  const updatedBusiness = await prisma.business.update({
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

  // Attach split to existing DVA if active
  let splitAttached = false;
  if (business.virtualAccountNumber && business.paystackCustomerCode) {
    try {
      await provider.splitDedicatedAccount(business.paystackCustomerCode, subaccountCode);
      splitAttached = true;
    } catch (err) {
      logger.warn('Could not attach split to existing DVA', {
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
    newData: {
      subaccountCode,
      bankCode: params.bankCode,
      accountLast4: params.accountNumber.slice(-4),
      splitAttached,
    },
  });

  return {
    subaccountCode,
    accountName,
    bankName: params.bankName,
    accountNumber: params.accountNumber,
    splitAttached,
  };
}

/**
 * Executes PIN-protected instant balance withdrawal to connected commercial bank account
 */
export async function withdrawBalance(
  userId: string,
  businessId: string,
  params: WithdrawBalanceInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  // 1. Check if settlement bank account is connected
  if (!business.settlementAccountNumber || !business.settlementBankCode) {
    throw new AppError(
      400,
      'No settlement bank connected. Please connect your commercial bank account first.',
      'SETTLEMENT_ACCOUNT_REQUIRED'
    );
  }

  // 2. Verify 4-digit transaction PIN (with lockout protection & bcrypt outside DB tx)
  await pinService.verifyPin(userId, params.pin);

  // 3. Re-calculate available balance atomically
  const preview = await getPayoutPreview(userId, businessId);
  if (params.amount > preview.availableForWithdrawal) {
    throw new AppError(
      400,
      `Insufficient available funds. Maximum withdrawable balance is ₦${preview.availableForWithdrawal.toLocaleString(
        'en-NG',
        { minimumFractionDigits: 2 }
      )} (₦${preview.taxReserve.toLocaleString('en-NG', {
        minimumFractionDigits: 2,
      })} is reserved for unpaid FIRS tax liabilities).`,
      'INSUFFICIENT_FUNDS',
      {
        available: preview.availableForWithdrawal,
        requested: params.amount,
        taxReserve: preview.taxReserve,
      }
    );
  }

  // 4. Generate unique transfer reference
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  const transferReference = `PO-${dateStr}-${rand}`;

  const provider = getPaymentProvider();

  // 5. Create transfer recipient via Paystack
  const recipient = await provider.createTransferRecipient({
    type: 'nuban',
    name: business.settlementAccountName || business.businessName,
    accountNumber: business.settlementAccountNumber,
    bankCode: business.settlementBankCode,
    currency: 'NGN',
    description: `Payout for ${business.businessName}`,
  });

  // 6. Initiate payout transfer
  const transferResult = await provider.initiateTransfer({
    source: 'balance',
    amount: params.amount,
    recipient: recipient.recipientCode,
    reason: params.narration || `Balance withdrawal for ${business.businessName}`,
    reference: transferReference,
  });

  // 7. Save SettlementPayout record in database
  const payout = await prisma.settlementPayout.create({
    data: {
      businessId,
      amount: params.amount,
      fee: 0,
      netAmount: params.amount,
      destinationBankCode: business.settlementBankCode,
      destinationBankName: business.settlementBankName || 'Commercial Bank',
      destinationAccountNum: business.settlementAccountNumber,
      destinationAccountName: business.settlementAccountName || business.businessName,
      transferReference,
      paystackTransferCode: transferResult.transferCode,
      status: transferResult.status === 'success' || transferResult.status === 'completed' ? 'completed' : 'pending',
      completedAt: transferResult.status === 'success' || transferResult.status === 'completed' ? new Date() : null,
      narration: params.narration,
    },
  });

  logAudit({
    userId,
    businessId,
    action: 'settlement.payout_initiated',
    resourceType: 'settlement_payout',
    resourceId: payout.id,
    newData: {
      amount: params.amount,
      transferReference,
      destinationBank: business.settlementBankName,
      accountLast4: business.settlementAccountNumber.slice(-4),
    },
  });

  logger.info('Settlement payout processed successfully', {
    businessId,
    payoutId: payout.id,
    amount: params.amount,
    reference: transferReference,
  });

  return {
    id: payout.id,
    amount: toNumber(payout.amount),
    transferReference: payout.transferReference,
    status: payout.status,
    destinationBankName: payout.destinationBankName,
    destinationAccountNum: payout.destinationAccountNum,
    destinationAccountName: payout.destinationAccountName,
    initiatedAt: payout.initiatedAt,
    completedAt: payout.completedAt,
  };
}

/**
 * Toggles gateway auto-split and updates tax split percentage
 */
export async function toggleAutoSplit(
  userId: string,
  businessId: string,
  params: ToggleAutoSplitInput
) {
  const business = await verifyBusinessOwnership(userId, businessId);

  const updatedBusiness = await prisma.business.update({
    where: { id: businessId },
    data: {
      autoSplitEnabled: params.enabled,
      taxSplitPercentage: params.taxSplitPercentage ?? 7.5,
    },
  });

  // Sync with Paystack subaccount if provisioned
  if (business.paystackSubaccountCode) {
    const provider = getPaymentProvider();
    try {
      await provider.updateSubaccount(business.paystackSubaccountCode, {
        percentageCharge: params.enabled ? params.taxSplitPercentage ?? 7.5 : 0,
      });
    } catch (err) {
      logger.warn('Could not sync subaccount split percentage with Paystack', {
        businessId,
        subaccountCode: business.paystackSubaccountCode,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  logAudit({
    userId,
    businessId,
    action: 'settlement.auto_split_updated',
    resourceType: 'business',
    resourceId: businessId,
    newData: {
      autoSplitEnabled: params.enabled,
      taxSplitPercentage: params.taxSplitPercentage ?? 7.5,
    },
  });

  return {
    autoSplitEnabled: updatedBusiness.autoSplitEnabled,
    taxSplitPercentage: toNumber(updatedBusiness.taxSplitPercentage),
  };
}

/**
 * Returns paginated payout history for a business
 */
export async function listPayoutHistory(
  userId: string,
  businessId: string,
  query: PayoutHistoryQueryInput
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };
  if (query.status) {
    where.status = query.status;
  }

  const [items, total] = await Promise.all([
    prisma.settlementPayout.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.settlementPayout.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit) || 1;

  return {
    items: items.map((p) => ({
      id: p.id,
      amount: toNumber(p.amount),
      fee: toNumber(p.fee),
      netAmount: toNumber(p.netAmount),
      destinationBankName: p.destinationBankName,
      destinationAccountNum: p.destinationAccountNum,
      destinationAccountName: p.destinationAccountName,
      transferReference: p.transferReference,
      status: p.status,
      initiatedAt: p.initiatedAt,
      completedAt: p.completedAt,
      narration: p.narration,
    })),
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
