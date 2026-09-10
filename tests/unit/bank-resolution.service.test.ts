import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
  resolveSettlementAccount,
  connectSettlementBank,
} from '@/modules/wallet/services/bank-resolution.service';
import * as paymentModule from '@/lib/payment';
import * as withdrawalActorModule from '@/shared/helpers/withdrawal-actor';
import * as payoutLockModule from '@/lib/payout-lock';
import * as auditModule from '@/lib/audit';
import prisma from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

describe('BankResolutionService Unit Suite', () => {
  const mockUserId = 'usr-bank-001';
  const mockBusinessId = 'biz-bank-001';

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(auditModule, 'logAudit').mockReturnValue(undefined as any);
  });

  describe('resolveSettlementAccount', () => {
    test('successfully resolves commercial bank account name via Paystack provider', async () => {
      const mockProvider = {
        resolveAccount: jest.fn<any>().mockResolvedValue({
          bankCode: '058',
          accountNumber: '0123456789',
          accountName: 'TEST BUSINESS ENTERPRISE',
        }),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      const result = await resolveSettlementAccount({
        accountNumber: '0123456789',
        bankCode: '058',
      });

      expect(mockProvider.resolveAccount).toHaveBeenCalledWith('0123456789', '058');
      expect(result).toEqual({
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'TEST BUSINESS ENTERPRISE',
      });
    });

    test('propagates error when account cannot be resolved', async () => {
      const mockProvider = {
        resolveAccount: jest.fn<any>().mockRejectedValue(new AppError(422, 'Could not resolve account name', 'ACCOUNT_RESOLVE_FAILED')),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      await expect(
        resolveSettlementAccount({
          accountNumber: '0000000000',
          bankCode: '999',
        })
      ).rejects.toThrow('Could not resolve account name');
    });
  });

  describe('connectSettlementBank', () => {
    test('successfully connects new settlement account without PIN when no account exists yet', async () => {
      const mockBusiness = {
        id: mockBusinessId,
        userId: mockUserId,
        businessName: 'Apex Stores',
        settlementAccountNumber: null,
        settlementBankCode: null,
        paystackSubaccountCode: null,
        taxSplitPercentage: 7.5,
        user: {
          id: mockUserId,
          settlementAccountNumber: null,
          settlementBankCode: null,
          transactionPin: null,
          pinLockedUntil: null,
          pinAttempts: 0,
        },
      };

      jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);
      jest.spyOn(payoutLockModule, 'assertPayoutChangeAllowed').mockReturnValue(undefined);

      const mockProvider = {
        resolveAccount: jest.fn<any>().mockResolvedValue({
          bankCode: '058',
          accountNumber: '0123456789',
          accountName: 'APEX STORES',
        }),
        createSubaccount: jest.fn<any>().mockResolvedValue({
          subaccountCode: 'SUB_apex123',
        }),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      jest.spyOn(prisma.business, 'update').mockResolvedValue({
        settlementBankName: 'GTBank',
        settlementBankCode: '058',
        settlementAccountNumber: '0123456789',
        settlementAccountName: 'APEX STORES',
        settlementConnectedAt: new Date(),
        paystackSubaccountCode: 'SUB_apex123',
      } as any);

      jest.spyOn(prisma.user, 'update').mockResolvedValue({} as any);

      const result = await connectSettlementBank(mockUserId, mockBusinessId, {
        bankCode: '058',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });

      expect(result.accountNumber).toBe('0123456789');
      expect(result.accountName).toBe('APEX STORES');
      expect(result.subaccountCode).toBe('SUB_apex123');
      expect(mockProvider.createSubaccount).toHaveBeenCalled();
    });

    test('enforces PIN verification when changing an existing connected account', async () => {
      const mockBusiness = {
        id: mockBusinessId,
        userId: mockUserId,
        businessName: 'Apex Stores',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        paystackSubaccountCode: 'SUB_apex123',
        taxSplitPercentage: 7.5,
        user: {
          id: mockUserId,
          settlementAccountNumber: '0123456789',
          settlementBankCode: '058',
          transactionPin: '$2b$12$hashed...',
          pinLockedUntil: null,
          pinAttempts: 0,
        },
      };

      jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);
      jest.spyOn(payoutLockModule, 'assertPayoutChangeAllowed').mockReturnValue(undefined);

      // Throws PIN_REQUIRED if pin is not supplied on change
      await expect(
        connectSettlementBank(mockUserId, mockBusinessId, {
          bankCode: '033',
          bankName: 'UBA',
          accountNumber: '2001234567',
        })
      ).rejects.toThrow('Transaction PIN or step-up authorization token is required to change your payout account');
    });
  });
});
