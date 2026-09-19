import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { connectSettlementBank } from '@/modules/wallet/services/bank-resolution.service';
import * as paymentModule from '@/lib/payment';
import * as withdrawalActorModule from '@/shared/helpers/withdrawal-actor';
import * as payoutLockModule from '@/lib/payout-lock';
import * as auditModule from '@/lib/audit';
import * as pinService from '@/services/pin.service';
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';

describe('ARCH-10: Bank Resolution Subaccount Split Binding Suite', () => {
  const mockUserId = 'usr-split-001';
  const mockBusinessId = 'biz-split-001';

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(auditModule, 'logAudit').mockReturnValue(undefined as any);
    jest.spyOn(payoutLockModule, 'assertPayoutChangeAllowed').mockReturnValue(undefined);
    jest.spyOn(pinService, 'verifyPin').mockResolvedValue(undefined as any);
  });

  test('1. New subaccount with DVA: calls createSubaccount, calls splitDedicatedAccount, sets autoSplitEnabled: true', async () => {
    const mockBusiness = {
      id: mockBusinessId,
      userId: mockUserId,
      businessName: 'Apex Stores',
      settlementAccountNumber: null,
      settlementBankCode: null,
      paystackSubaccountCode: null,
      virtualAccountNumber: '9912345678',
      paystackCustomerCode: 'CUS_apex_123',
      taxSplitPercentage: 7.5,
      user: {
        id: mockUserId,
        settlementAccountNumber: null,
        settlementBankCode: null,
      },
    };

    jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);

    const mockProvider = {
      resolveAccount: jest.fn<any>().mockResolvedValue({
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'APEX STORES',
      }),
      createSubaccount: jest.fn<any>().mockResolvedValue({
        subaccountCode: 'SUB_apex123',
      }),
      splitDedicatedAccount: jest.fn<any>().mockResolvedValue({
        accountNumber: '9912345678',
        bankName: 'Wema Bank',
      }),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const updateSpy = jest.spyOn(prisma.business, 'update').mockResolvedValue({} as any);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as any);

    const result = await connectSettlementBank(mockUserId, mockBusinessId, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: '0123456789',
    });

    expect(mockProvider.createSubaccount).toHaveBeenCalledTimes(1);
    expect(mockProvider.splitDedicatedAccount).toHaveBeenCalledWith('CUS_apex_123', 'SUB_apex123');
    expect(result.splitAttached).toBe(true);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBusinessId },
        data: expect.objectContaining({
          paystackSubaccountCode: 'SUB_apex123',
          autoSplitEnabled: true,
        }),
      })
    );
  });

  test('2. New subaccount without DVA: creates subaccount, does NOT call splitDedicatedAccount, sets autoSplitEnabled: false', async () => {
    const mockBusiness = {
      id: mockBusinessId,
      userId: mockUserId,
      businessName: 'Apex Stores',
      settlementAccountNumber: null,
      settlementBankCode: null,
      paystackSubaccountCode: null,
      virtualAccountNumber: null,
      paystackCustomerCode: null,
      user: {
        id: mockUserId,
        settlementAccountNumber: null,
      },
    };

    jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);

    const mockProvider = {
      resolveAccount: jest.fn<any>().mockResolvedValue({
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'APEX STORES',
      }),
      createSubaccount: jest.fn<any>().mockResolvedValue({
        subaccountCode: 'SUB_apex123',
      }),
      splitDedicatedAccount: jest.fn<any>(),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const updateSpy = jest.spyOn(prisma.business, 'update').mockResolvedValue({} as any);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as any);

    const result = await connectSettlementBank(mockUserId, mockBusinessId, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: '0123456789',
    });

    expect(mockProvider.createSubaccount).toHaveBeenCalledTimes(1);
    expect(mockProvider.splitDedicatedAccount).not.toHaveBeenCalled();
    expect(result.splitAttached).toBe(false);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBusinessId },
        data: expect.objectContaining({
          autoSplitEnabled: false,
        }),
      })
    );
  });

  test('3. Update existing subaccount with DVA: updates subaccount, re-calls splitDedicatedAccount, sets autoSplitEnabled: true', async () => {
    const mockBusiness = {
      id: mockBusinessId,
      userId: mockUserId,
      businessName: 'Apex Stores',
      settlementAccountNumber: '0123456789',
      settlementBankCode: '058',
      paystackSubaccountCode: 'SUB_existing_999',
      virtualAccountNumber: '9912345678',
      paystackCustomerCode: 'CUS_apex_123',
      user: {
        id: mockUserId,
        settlementAccountNumber: '0123456789',
      },
    };

    jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);

    const mockProvider = {
      resolveAccount: jest.fn<any>().mockResolvedValue({
        bankCode: '033',
        accountNumber: '2001234567',
        accountName: 'APEX STORES',
      }),
      updateSubaccount: jest.fn<any>().mockResolvedValue({
        subaccountCode: 'SUB_existing_999',
      }),
      splitDedicatedAccount: jest.fn<any>().mockResolvedValue({
        accountNumber: '9912345678',
        bankName: 'Wema Bank',
      }),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const updateSpy = jest.spyOn(prisma.business, 'update').mockResolvedValue({} as any);

    const result = await connectSettlementBank(mockUserId, mockBusinessId, {
      bankCode: '033',
      bankName: 'UBA',
      accountNumber: '2001234567',
      pin: '1234',
    });

    expect(mockProvider.updateSubaccount).toHaveBeenCalledWith('SUB_existing_999', expect.any(Object));
    expect(mockProvider.splitDedicatedAccount).toHaveBeenCalledWith('CUS_apex_123', 'SUB_existing_999');
    expect(result.splitAttached).toBe(true);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBusinessId },
        data: expect.objectContaining({
          paystackSubaccountCode: 'SUB_existing_999',
          autoSplitEnabled: true,
        }),
      })
    );
  });

  test('4. Split call fails on update: logs error, sets splitAttached = false and autoSplitEnabled: false', async () => {
    const mockBusiness = {
      id: mockBusinessId,
      userId: mockUserId,
      businessName: 'Apex Stores',
      settlementAccountNumber: '0123456789',
      settlementBankCode: '058',
      paystackSubaccountCode: 'SUB_existing_999',
      virtualAccountNumber: '9912345678',
      paystackCustomerCode: 'CUS_apex_123',
      user: {
        id: mockUserId,
        settlementAccountNumber: '0123456789',
      },
    };

    jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);
    const loggerErrorSpy = jest.spyOn(logger, 'error').mockReturnValue(logger as any);

    const mockProvider = {
      resolveAccount: jest.fn<any>().mockResolvedValue({
        bankCode: '033',
        accountNumber: '2001234567',
        accountName: 'APEX STORES',
      }),
      updateSubaccount: jest.fn<any>().mockResolvedValue({
        subaccountCode: 'SUB_existing_999',
      }),
      splitDedicatedAccount: jest.fn<any>().mockRejectedValue(new Error('Paystack split failed')),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const updateSpy = jest.spyOn(prisma.business, 'update').mockResolvedValue({} as any);

    const result = await connectSettlementBank(mockUserId, mockBusinessId, {
      bankCode: '033',
      bankName: 'UBA',
      accountNumber: '2001234567',
      pin: '1234',
    });

    expect(result.splitAttached).toBe(false);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to re-attach split to DVA during subaccount update'),
      expect.any(Object)
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBusinessId },
        data: expect.objectContaining({
          autoSplitEnabled: false,
        }),
      })
    );
  });

  test('5. Split call fails on create: logs error, sets splitAttached = false and autoSplitEnabled: false', async () => {
    const mockBusiness = {
      id: mockBusinessId,
      userId: mockUserId,
      businessName: 'Apex Stores',
      settlementAccountNumber: null,
      settlementBankCode: null,
      paystackSubaccountCode: null,
      virtualAccountNumber: '9912345678',
      paystackCustomerCode: 'CUS_apex_123',
      user: {
        id: mockUserId,
        settlementAccountNumber: null,
      },
    };

    jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue(mockBusiness as any);
    const loggerErrorSpy = jest.spyOn(logger, 'error').mockReturnValue(logger as any);

    const mockProvider = {
      resolveAccount: jest.fn<any>().mockResolvedValue({
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'APEX STORES',
      }),
      createSubaccount: jest.fn<any>().mockResolvedValue({
        subaccountCode: 'SUB_new_123',
      }),
      splitDedicatedAccount: jest.fn<any>().mockRejectedValue(new Error('Gateway timeout')),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const updateSpy = jest.spyOn(prisma.business, 'update').mockResolvedValue({} as any);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as any);

    const result = await connectSettlementBank(mockUserId, mockBusinessId, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: '0123456789',
    });

    expect(result.splitAttached).toBe(false);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to attach split to existing DVA during initial subaccount creation'),
      expect.any(Object)
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBusinessId },
        data: expect.objectContaining({
          autoSplitEnabled: false,
        }),
      })
    );
  });
});
