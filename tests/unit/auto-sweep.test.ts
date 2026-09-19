import { describe, test, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined as any),
}));

jest.mock('../../src/services/reminder.service', () => ({
  createReminderOnce: jest.fn().mockResolvedValue({ id: 'rem-1' } as any),
}));

jest.mock('../../src/services/reminder/reminder-generation.service', () => ({
  createReminderOnce: jest.fn().mockResolvedValue({ id: 'rem-1' } as any),
}));

import { runAutoSweep } from '@/jobs/wallet-auto-sweep.cron';
import prisma from '@/lib/prisma';
import { WalletService } from '@/services/wallet.service';
import { PlatformConfigService } from '@/services/platform-config.service';
import * as paymentModule from '@/lib/payment';
import { AppError } from '@/middleware/errorHandler';

describe('ARCH-09: Wallet Anti-Deposit Auto-Sweep Unit Suite', () => {
  const mockUserId = 'usr-sweep-001';
  const mockBizId = 'biz-sweep-001';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(PlatformConfigService, 'getFeeConfig').mockResolvedValue({
      withdrawalFeePct: 0,
      withdrawalFeeCap: 0,
      minWithdrawalAmount: 100,
    } as any);
    // Default: no prior sweeps today (dedup query returns empty)
    jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([]);
  });

  test('1. Sweeps eligible wallet with balance >= threshold and connected bank', async () => {
    const mockWallet = {
      userId: mockUserId,
      balance: 5000,
      lockedBalance: 0,
      user: {
        id: mockUserId,
        email: 'merchant@apex.ng',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        settlementBankName: 'GTBank',
        settlementAccountName: 'Apex Merchant',
        businesses: [
          {
            id: mockBizId,
            businessName: 'Apex Enterprise',
            settlementAccountNumber: '0123456789',
            settlementBankCode: '058',
            settlementBankName: 'GTBank',
            settlementAccountName: 'Apex Merchant',
            autoPayoutEnabled: true,
          },
        ],
      },
    };

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([mockWallet] as any);
    jest.spyOn(WalletService, 'checkLivePaystackBalance').mockResolvedValue({
      canPayout: true,
      paystackBalanceNaira: 500000,
      deficit: 0,
    });

    const mockProvider = {
      createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_123' }),
      initiateTransfer: jest.fn<any>().mockResolvedValue({
        status: 'success',
        transferCode: 'TRF_test_001',
      }),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const mockCreatedPayout = {
      id: 'payout-sweep-1',
      businessId: mockBizId,
      amount: 5000,
      fee: 0,
      netAmount: 5000,
      destinationBankName: 'GTBank',
      destinationAccountNum: '0123456789',
      destinationAccountName: 'Apex Merchant',
      destinationBankCode: '058',
      transferReference: 'SWEEP-20260918-ABCDE',
      narration: 'Auto-sweep: regulatory clearing',
      status: 'processing',
    };

    const mockTx = {
      $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: true }]),
      settlementPayout: {
        create: jest.fn<any>().mockResolvedValue(mockCreatedPayout),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(mockTx));

    jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);
    jest.spyOn(WalletService, 'reserveFunds').mockResolvedValue({} as any);
    const settleSpy = jest.spyOn(WalletService, 'settlePayoutDebit').mockResolvedValue({} as any);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.sweepsAttempted).toBe(1);
    expect(result.sweepsCompleted).toBe(1);
    expect(result.sweepsFailed).toBe(0);
    expect(result.totalSweptNaira).toBe(5000);

    expect(mockTx.settlementPayout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          businessId: mockBizId,
          amount: 5000,
          status: 'processing',
        }),
      })
    );
    expect(mockProvider.createTransferRecipient).toHaveBeenCalled();
    expect(mockProvider.initiateTransfer).toHaveBeenCalled();
    expect(settleSpy).toHaveBeenCalled();
  });

  test('2. Skips wallet with balance below threshold', async () => {
    // Prisma query filters by gte: 1000, so findMany returns empty
    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([]);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.walletsChecked).toBe(0);
    expect(result.sweepsAttempted).toBe(0);
  });

  test('3. Skips wallet with no settlement bank connected and increments skippedNoBank', async () => {
    const mockWallet = {
      userId: mockUserId,
      balance: 5000,
      lockedBalance: 0,
      user: {
        id: mockUserId,
        email: 'nobank@apex.ng',
        settlementAccountNumber: null,
        settlementBankCode: null,
        businesses: [
          {
            id: mockBizId,
            businessName: 'No Bank Enterprise',
            settlementAccountNumber: null,
            settlementBankCode: null,
          },
        ],
      },
    };

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([mockWallet] as any);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.walletsChecked).toBe(1);
    expect(result.skippedNoBank).toBe(1);
    expect(result.sweepsAttempted).toBe(0);
  });

  test('4. Skips wallet when available balance (balance - lockedBalance) is below threshold', async () => {
    const mockWallet = {
      userId: mockUserId,
      balance: 5000,
      lockedBalance: 4500, // available = 500 < 1000
      user: {
        id: mockUserId,
        email: 'locked@apex.ng',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        businesses: [
          {
            id: mockBizId,
            businessName: 'Locked Enterprise',
            settlementAccountNumber: '0123456789',
            settlementBankCode: '058',
          },
        ],
      },
    };

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([mockWallet] as any);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.walletsChecked).toBe(1);
    expect(result.sweepsAttempted).toBe(0);
  });

  test('5. Halts sweep batch when Paystack balance is insufficient', async () => {
    const mockWallets = [
      {
        userId: 'usr-1',
        balance: 5000,
        lockedBalance: 0,
        user: {
          id: 'usr-1',
          email: 'u1@apex.ng',
          settlementAccountNumber: '0123456789',
          settlementBankCode: '058',
          businesses: [{ id: 'b1', businessName: 'B1', settlementAccountNumber: '0123456789', settlementBankCode: '058' }],
        },
      },
      {
        userId: 'usr-2',
        balance: 8000,
        lockedBalance: 0,
        user: {
          id: 'usr-2',
          email: 'u2@apex.ng',
          settlementAccountNumber: '0123456789',
          settlementBankCode: '058',
          businesses: [{ id: 'b2', businessName: 'B2', settlementAccountNumber: '0123456789', settlementBankCode: '058' }],
        },
      },
    ];

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue(mockWallets as any);
    // Insufficient gateway balance
    jest.spyOn(WalletService, 'checkLivePaystackBalance').mockResolvedValue({
      canPayout: false,
      paystackBalanceNaira: 100,
      deficit: 4900,
    });

    const result = await runAutoSweep({ bypassLock: true });

    // Halts immediately before attempting any sweeps
    expect(result.sweepsAttempted).toBe(0);
    expect(result.sweepsCompleted).toBe(0);
  });

  test('6. Handles ambiguous transfer error (timeout): keeps funds locked and marks processing', async () => {
    const mockWallet = {
      userId: mockUserId,
      balance: 5000,
      lockedBalance: 0,
      user: {
        id: mockUserId,
        email: 'merchant@apex.ng',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        businesses: [
          {
            id: mockBizId,
            businessName: 'Apex Enterprise',
            settlementAccountNumber: '0123456789',
            settlementBankCode: '058',
          },
        ],
      },
    };

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([mockWallet] as any);
    jest.spyOn(WalletService, 'checkLivePaystackBalance').mockResolvedValue({
      canPayout: true,
      paystackBalanceNaira: 500000,
      deficit: 0,
    });

    // Simulate ambiguous timeout error (PAYSTACK_TIMEOUT)
    const timeoutError = new AppError(504, 'Gateway timeout', 'PAYSTACK_TIMEOUT');
    const mockProvider = {
      createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_123' }),
      initiateTransfer: jest.fn<any>().mockRejectedValue(timeoutError),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const mockCreatedPayout = {
      id: 'payout-ambiguous-1',
      businessId: mockBizId,
      amount: 5000,
      fee: 0,
      netAmount: 5000,
      destinationBankName: 'GTBank',
      destinationAccountNum: '0123456789',
      destinationAccountName: 'Apex Merchant',
      destinationBankCode: '058',
      transferReference: 'SWEEP-20260918-TIMEOUT',
      status: 'processing',
    };

    const mockTx = {
      $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: true }]),
      settlementPayout: {
        create: jest.fn<any>().mockResolvedValue(mockCreatedPayout),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(mockTx));

    const updateSpy = jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);
    const releaseSpy = jest.spyOn(WalletService, 'releaseLockedFunds').mockResolvedValue({} as any);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.sweepsAttempted).toBe(1);
    expect(result.sweepsFailed).toBe(1);
    expect(result.sweepsCompleted).toBe(0);

    // Assert payout updated to processing (awaiting cron reconciliation)
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'payout-ambiguous-1' },
        data: expect.objectContaining({
          status: 'processing',
        }),
      })
    );
    // Locked funds MUST NOT be released when ambiguous
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  test('7. Handles deterministic transfer failure: releases locked funds back to available balance', async () => {
    const mockWallet = {
      userId: mockUserId,
      balance: 5000,
      lockedBalance: 0,
      user: {
        id: mockUserId,
        email: 'merchant@apex.ng',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        businesses: [
          {
            id: mockBizId,
            businessName: 'Apex Enterprise',
            settlementAccountNumber: '0123456789',
            settlementBankCode: '058',
          },
        ],
      },
    };

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([mockWallet] as any);
    jest.spyOn(WalletService, 'checkLivePaystackBalance').mockResolvedValue({
      canPayout: true,
      paystackBalanceNaira: 500000,
      deficit: 0,
    });

    // Deterministic 400 error from Paystack
    const deterministicError = new AppError(400, 'Account number is invalid', 'INVALID_ACCOUNT');
    const mockProvider = {
      createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_123' }),
      initiateTransfer: jest.fn<any>().mockRejectedValue(deterministicError),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    const mockCreatedPayout = {
      id: 'payout-failed-1',
      businessId: mockBizId,
      amount: 5000,
      fee: 0,
      netAmount: 5000,
      destinationBankName: 'GTBank',
      destinationAccountNum: '0123456789',
      destinationAccountName: 'Apex Merchant',
      destinationBankCode: '058',
      transferReference: 'SWEEP-20260918-FAILED',
      status: 'processing',
    };

    const mockTx = {
      $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: true }]),
      settlementPayout: {
        create: jest.fn<any>().mockResolvedValue(mockCreatedPayout),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(mockTx));

    const updateSpy = jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);
    const releaseSpy = jest.spyOn(WalletService, 'releaseLockedFunds').mockResolvedValue({} as any);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.sweepsAttempted).toBe(1);
    expect(result.sweepsFailed).toBe(1);
    expect(result.sweepsCompleted).toBe(0);

    // Payout marked failed
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'payout-failed-1' },
        data: expect.objectContaining({
          status: 'failed',
        }),
      })
    );
    // Locked funds MUST be released on deterministic rejection
    expect(releaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUserId,
        amount: 5000,
      })
    );
  });

  test('8. Advisory lock prevents concurrent execution when another worker holds lock', async () => {
    // Mock $transaction returning locked: false
    const mockTx = {
      $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: false }]),
    };
    jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      return callback(mockTx);
    });

    const result = await runAutoSweep();

    expect(result).toEqual({
      walletsChecked: 0,
      sweepsAttempted: 0,
      sweepsCompleted: 0,
      sweepsFailed: 0,
      skippedNoBank: 0,
      skippedBelowMin: 0,
      skippedAlreadySwept: 0,
      totalSweptNaira: 0,
    });
  });

  test('9. Skips execution completely when autoSweepEnabled is administratively set to false', async () => {
    jest.spyOn(PlatformConfigService, 'isAutoSweepEnabled').mockResolvedValue({
      enabled: false,
      thresholdNaira: 1000,
    });
    const findManySpy = jest.spyOn(prisma.walletBalance, 'findMany');

    const result = await runAutoSweep({ bypassLock: true });

    expect(result).toEqual({
      walletsChecked: 0,
      sweepsAttempted: 0,
      sweepsCompleted: 0,
      sweepsFailed: 0,
      skippedNoBank: 0,
      skippedBelowMin: 0,
      skippedAlreadySwept: 0,
      totalSweptNaira: 0,
    });
    expect(findManySpy).not.toHaveBeenCalled();
  });

  test('10. Executes sweep when autoSweepEnabled is false if force: true is passed', async () => {
    jest.spyOn(PlatformConfigService, 'isAutoSweepEnabled').mockResolvedValue({
      enabled: false,
      thresholdNaira: 1000,
    });
    const findManySpy = jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([]);

    const result = await runAutoSweep({ bypassLock: true, force: true });

    expect(findManySpy).toHaveBeenCalled();
    expect(result.walletsChecked).toBe(0);
  });

  test('11. Uses dynamic autoSweepThreshold configured in database', async () => {
    jest.spyOn(PlatformConfigService, 'isAutoSweepEnabled').mockResolvedValue({
      enabled: true,
      thresholdNaira: 5000,
    });
    const findManySpy = jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([]);

    await runAutoSweep({ bypassLock: true });

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          balance: { gte: 5000 },
        }),
      })
    );
  });

  test('12. PlatformConfigService.toggleAutoSweep updates database and emits audit', async () => {
    jest.spyOn(PlatformConfigService, 'getFeeConfig').mockResolvedValue({
      withdrawalFeePct: 1,
      withdrawalFeeCap: 300,
      minWithdrawalAmount: 1000,
      autoSweepEnabled: true,
      autoSweepThreshold: 1000,
    } as any);

    jest.spyOn(prisma.platformFeeConfig, 'upsert').mockResolvedValue({
      id: 'default',
      withdrawalFeePct: 1,
      withdrawalFeeCap: 300,
      minWithdrawalAmount: 1000,
      autoSweepEnabled: false,
      autoSweepThreshold: 1000,
      updatedAt: new Date(),
      updatedBy: 'admin-usr-999',
    } as any);

    const updated = await PlatformConfigService.toggleAutoSweep(false, 'admin-usr-999');

    expect(updated.autoSweepEnabled).toBe(false);
    expect(prisma.platformFeeConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'default' },
        update: expect.objectContaining({
          autoSweepEnabled: false,
          updatedBy: 'admin-usr-999',
        }),
      })
    );
  });

  test('13. Skips business already swept today (daily dedup prevents re-sweep after auto-sync refill)', async () => {
    const mockWallet = {
      userId: mockUserId,
      balance: 5000,
      lockedBalance: 0,
      user: {
        id: mockUserId,
        email: 'merchant@apex.ng',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        settlementBankName: 'GTBank',
        settlementAccountName: 'Apex Merchant',
        businesses: [
          {
            id: mockBizId,
            businessName: 'Apex Enterprise',
            settlementAccountNumber: '0123456789',
            settlementBankCode: '058',
            settlementBankName: 'GTBank',
            settlementAccountName: 'Apex Merchant',
            autoPayoutEnabled: true,
          },
        ],
      },
    };

    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([mockWallet] as any);

    // Simulate that this business was already swept today
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([
      { businessId: mockBizId, transferReference: `SWEEP-${todayStr}-ABC123`, status: 'completed' },
    ] as any);

    const result = await runAutoSweep({ bypassLock: true });

    expect(result.walletsChecked).toBe(1);
    expect(result.skippedAlreadySwept).toBe(1);
    expect(result.sweepsAttempted).toBe(0);
    expect(result.sweepsCompleted).toBe(0);
  });
});
