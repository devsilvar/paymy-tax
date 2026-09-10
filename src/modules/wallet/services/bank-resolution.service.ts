/**
 * Bank Resolution Service
 * 
 * Handles commercial bank account resolution and settlement subaccount linking.
 * 
 * Part of Phase 3 Service Decomposition from settlement.service.ts.
 * 
 * @author WallX Engineering Team
 */

import prisma from '@/lib/prisma';
import { getPaymentProvider } from '@/lib/payment';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import * as pinService from '@/services/pin.service';
import config from '@/config';
import {
  ConnectSettlementInput,
  ResolveSettlementInput,
} from '@/validators/settlement.validator';
import { getWithdrawalActor } from '@/shared/helpers';
import { assertPayoutChangeAllowed } from '@/lib/payout-lock';

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
 * 
 * Enforces payout account lock:
 * - First connect: no PIN required
 * - Changing existing account: requires admin-granted permission + PIN
 * - Permission expires 24 hours after grant
 * - Updates existing subaccount instead of creating orphans
 */
export async function connectSettlementBank(
  userId: string,
  businessId: string,
  params: ConnectSettlementInput
) {
  const business = await getWithdrawalActor(userId, businessId);
  const provider = getPaymentProvider();

  // Check if this is a change (existing account) or first connect
  const isChange = Boolean(business.settlementAccountNumber);

  // 1. Enforce payout lock for changes (throws 403 if locked or expired)
  if (isChange) {
    assertPayoutChangeAllowed(business);

    // 2. Require PIN or step-up token for money-path changes
    if (params.stepUpToken) {
      pinService.verifyStepUpToken(userId, params.stepUpToken);
    } else if (params.pin) {
      await pinService.verifyPin(userId, params.pin);
    } else {
      throw new AppError(
        400,
        'Transaction PIN or step-up authorization token is required to change your payout account',
        'PIN_REQUIRED'
      );
    }
  }

  // 3. Re-resolve server-side (never trust client-supplied name)
  const { accountName } = await provider.resolveAccount(params.accountNumber, params.bankCode);

  let subaccountCode: string;
  let splitAttached = false;

  // 4. Update existing subaccount or create new one
  if (business.paystackSubaccountCode) {
    // Update in place to avoid orphaning the old subaccount
    await provider.updateSubaccount(business.paystackSubaccountCode, {
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
      percentageCharge: config.settlement.platformCommissionPct,
    });
    subaccountCode = business.paystackSubaccountCode;

    // Split already attached from previous setup
    splitAttached = Boolean(business.virtualAccountNumber && business.paystackCustomerCode);
  } else {
    // First time — create new subaccount
    const result = await provider.createSubaccount({
      businessName: business.businessName,
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
      percentageCharge: config.settlement.platformCommissionPct,
    });
    subaccountCode = result.subaccountCode;

    // Attach split to existing DVA if active
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
  }

  // 5. Save account details and consume permission atomically if this was a change
  const updateData: any = {
    paystackSubaccountCode: subaccountCode,
    settlementBankCode: params.bankCode,
    settlementBankName: params.bankName,
    settlementAccountNumber: params.accountNumber,
    settlementAccountName: accountName,
    platformCommissionPct: config.settlement.platformCommissionPct,
    settlementConnectedAt: new Date(),
  };

  // Consume one-shot permission atomically (race-proof)
  if (isChange && business.payoutChangePermitted) {
    updateData.payoutChangePermitted = false;
    updateData.payoutChangeUsedAt = new Date();
  }

  await prisma.business.update({
    where: { id: businessId },
    data: updateData,
  });

  // Save to user level if unset, establishing central user settlement account
  if (!business.user.settlementAccountNumber) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        settlementBankCode: params.bankCode,
        settlementBankName: params.bankName,
        settlementAccountNumber: params.accountNumber,
        settlementAccountName: accountName,
        settlementConnectedAt: new Date(),
      },
    });
  }

  // 6. Audit log
  logAudit({
    userId,
    businessId,
    action: isChange ? 'settlement.account_changed' : 'settlement.connected',
    resourceType: 'business',
    resourceId: businessId,
    oldData: isChange
      ? {
          bankCode: business.settlementBankCode,
          accountLast4: business.settlementAccountNumber?.slice(-4),
        }
      : undefined,
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
