import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const mockLogAudit = jest.fn().mockResolvedValue(undefined as any);
jest.mock('../../src/lib/audit', () => ({
  logAudit: mockLogAudit,
}));

import { runWalletReconciliationSweep } from '@/jobs/wallet-reconciliation.cron';
import { prisma } from '@/lib/prisma';
import * as paymentModule from '@/lib/payment';

describe('ARCH-08-B: Gateway 1:1 Solvency Oracle Unit Suite', () => {
  let mockProvider: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      getBalance: jest.fn(),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    // Mock empty wallets & txAggs to focus on Invariant 3
    jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue([] as any);
    jest.spyOn(prisma.walletTransaction, 'groupBy').mockResolvedValue([] as any);
  });

  test('1. Solvent state: Gateway balance exceeds platform liabilities (1:1 backing verified)', async () => {
    jest.spyOn(prisma.walletBalance, 'aggregate').mockResolvedValue({
      _sum: {
        balance: 5000000 as any,
        lockedBalance: 0 as any,
      },
    } as any);

    mockProvider.getBalance.mockResolvedValue([
      { currency: 'NGN', balanceNaira: 10000000 },
    ]);

    const result = await runWalletReconciliationSweep({ bypassLock: true });

    expect(result.totalLiabilitiesNaira).toBe(5000000);
    expect(result.gatewayBalanceNaira).toBe(10000000);
    expect(result.reserveRatio).toBe(2.0);
    expect(result.isSolvent).toBe(true);
    expect(result.solvencyDeficitNaira).toBe(0);
    expect(result.gatewayReachable).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('2. Insolvent deficit state: Gateway balance is less than liabilities (triggers alert & audit)', async () => {
    jest.spyOn(prisma.walletBalance, 'aggregate').mockResolvedValue({
      _sum: {
        balance: 4000000 as any,
        lockedBalance: 1000000 as any,
      },
    } as any);

    mockProvider.getBalance.mockResolvedValue([
      { currency: 'NGN', balanceNaira: 2000000 },
    ]);

    const result = await runWalletReconciliationSweep({ bypassLock: true });

    expect(result.totalLiabilitiesNaira).toBe(5000000);
    expect(result.gatewayBalanceNaira).toBe(2000000);
    expect(result.reserveRatio).toBeCloseTo(0.4, 4);
    expect(result.isSolvent).toBe(false);
    expect(result.solvencyDeficitNaira).toBe(3000000);
    expect(result.gatewayReachable).toBe(true);

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement.solvency_deficit_detected',
        resourceType: 'PlatformSolvency',
        resourceId: 'live_reserve',
        newData: {
          totalLiabilitiesNaira: 5000000,
          gatewayBalanceNaira: 2000000,
          reserveRatio: 0.4,
          solvencyDeficitNaira: 3000000,
        },
      })
    );
  });

  test('3. Zero obligations boundary: No liabilities defaults to solvent with ratio 1.0', async () => {
    jest.spyOn(prisma.walletBalance, 'aggregate').mockResolvedValue({
      _sum: {
        balance: null,
        lockedBalance: null,
      },
    } as any);

    mockProvider.getBalance.mockResolvedValue([
      { currency: 'NGN', balanceNaira: 0 },
    ]);

    const result = await runWalletReconciliationSweep({ bypassLock: true });

    expect(result.totalLiabilitiesNaira).toBe(0);
    expect(result.gatewayBalanceNaira).toBe(0);
    expect(result.reserveRatio).toBe(1.0);
    expect(result.isSolvent).toBe(true);
    expect(result.solvencyDeficitNaira).toBe(0);
    expect(result.gatewayReachable).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('4. Gateway unreachable: Network error sets gatewayReachable: false without false insolvency alarm', async () => {
    jest.spyOn(prisma.walletBalance, 'aggregate').mockResolvedValue({
      _sum: {
        balance: 5000000 as any,
        lockedBalance: 0 as any,
      },
    } as any);

    mockProvider.getBalance.mockRejectedValue(new Error('ETIMEDOUT: Connection refused by gateway'));

    const result = await runWalletReconciliationSweep({ bypassLock: true });

    expect(result.gatewayReachable).toBe(false);
    expect(result.isSolvent).toBe(true); // Provisional, no false alarm
    expect(result.solvencyDeficitNaira).toBe(0);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('5. Missing NGN currency balance: Defaults gateway NGN balance to 0 and detects deficit', async () => {
    jest.spyOn(prisma.walletBalance, 'aggregate').mockResolvedValue({
      _sum: {
        balance: 500000 as any,
        lockedBalance: 0 as any,
      },
    } as any);

    // Provider returns other currencies, but no NGN
    mockProvider.getBalance.mockResolvedValue([
      { currency: 'USD', balanceNaira: 1000 },
      { currency: 'GHS', balanceNaira: 500 },
    ]);

    const result = await runWalletReconciliationSweep({ bypassLock: true });

    expect(result.totalLiabilitiesNaira).toBe(500000);
    expect(result.gatewayBalanceNaira).toBe(0);
    expect(result.reserveRatio).toBe(0);
    expect(result.isSolvent).toBe(false);
    expect(result.solvencyDeficitNaira).toBe(500000);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
  });
});
