import { describe, test, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';

jest.mock('../../src/services/reminder.service', () => ({
  generateRemindersForAllBusinesses: jest.fn(),
  sweepOverdueInvoicesForBusiness: jest.fn(),
}));

jest.mock('../../src/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import prisma from '../../src/lib/prisma';

import { runDailySweep } from '../../src/jobs/reminders.cron';
import { runWalletReconciliationSweep } from '../../src/jobs/wallet-reconciliation.cron';
import {
  generateRemindersForAllBusinesses,
  sweepOverdueInvoicesForBusiness,
} from '../../src/services/reminder.service';
import * as settlementService from '../../src/services/settlement.service';
import { createSale } from '../../src/services/sales/sales-crud.service';
import * as ownershipLib from '../../src/lib/ownership';
import { Prisma } from '@prisma/client';

const mockGenerateReminders = generateRemindersForAllBusinesses as jest.MockedFunction<
  typeof generateRemindersForAllBusinesses
>;
const mockSweepOverdueInvoices = sweepOverdueInvoicesForBusiness as jest.MockedFunction<
  typeof sweepOverdueInvoicesForBusiness
>;

describe('Phase 2 Concurrency & Cron Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });


  describe('Reminders Cron (reminders.cron.ts)', () => {
    test('runDailySweep with bypassLock: true executes reminder and overdue invoice sweeps', async () => {
      const mockTaxResult = { processed: 5, created: 2, deadlinesCreated: 1 };
      const mockInvoiceResult = { remindersCreated: 3, statusFlipped: 3 };

      mockGenerateReminders.mockResolvedValue(mockTaxResult as any);
      mockSweepOverdueInvoices.mockResolvedValue(mockInvoiceResult as any);

      await runDailySweep({ bypassLock: true });

      expect(mockGenerateReminders).toHaveBeenCalledTimes(1);
      expect(mockSweepOverdueInvoices).toHaveBeenCalledTimes(1);
    });

    test('runDailySweep skips execution when advisory lock is already held', async () => {
      mockGenerateReminders.mockResolvedValue({} as any);

      // Mock transaction that returns locked: false
      jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: false }]),
        };
        return await callback(mockTx);
      });

      await runDailySweep();

      expect(mockGenerateReminders).not.toHaveBeenCalled();
    });

    test('runDailySweep executes sweep when advisory lock is successfully acquired', async () => {
      mockGenerateReminders.mockResolvedValue({ processed: 1, created: 0, deadlinesCreated: 0 } as any);
      mockSweepOverdueInvoices.mockResolvedValue({ remindersCreated: 0, statusFlipped: 0 } as any);

      jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: true }]),
        };
        return await callback(mockTx);
      });

      await runDailySweep();

      expect(mockGenerateReminders).toHaveBeenCalledTimes(1);
      expect(mockSweepOverdueInvoices).toHaveBeenCalledTimes(1);
    });
  });


  describe('Wallet Reconciliation Cron (wallet-reconciliation.cron.ts)', () => {
    test('runWalletReconciliationSweep uses batch groupBy and detects ledger drift', async () => {
      const mockWallets = [
        {
          id: 'wallet-1',
          userId: 'user-1',
          balance: new Prisma.Decimal(10000),
          user: {
            id: 'user-1',
            email: 'user1@example.com',
            businesses: [{ id: 'biz-1' }],
          },
        },
        {
          id: 'wallet-2',
          userId: 'user-2',
          balance: new Prisma.Decimal(5000), // Mismatches transaction sum (4000)
          user: {
            id: 'user-2',
            email: 'user2@example.com',
            businesses: [{ id: 'biz-2' }],
          },
        },
      ];

      const mockGroupBys = [
        {
          userId: 'user-1',
          _sum: { netAmount: new Prisma.Decimal(10000) },
          _count: { _all: 2 },
        },
        {
          userId: 'user-2',
          _sum: { netAmount: new Prisma.Decimal(4000) }, // 1000 drift
          _count: { _all: 1 },
        },
      ];

      jest.spyOn(prisma.walletBalance, 'findMany').mockResolvedValue(mockWallets as any);
      const groupBySpy = jest
        .spyOn(prisma.walletTransaction, 'groupBy')
        .mockResolvedValue(mockGroupBys as any);

      jest.spyOn(settlementService, 'getPayoutPreview').mockResolvedValue({
        availableForWithdrawal: 10000,
      } as any);

      const result = await runWalletReconciliationSweep({ bypassLock: true });

      expect(groupBySpy).toHaveBeenCalledTimes(1);
      expect(result.usersAudited).toBe(2);
      expect(result.ledgerMismatchCount).toBe(1); // user-2 drifted
    });

    test('runWalletReconciliationSweep skips when advisory lock is held', async () => {
      jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: false }]),
        };
        return await callback(mockTx);
      });

      const findManySpy = jest.spyOn(prisma.walletBalance, 'findMany');

      const result = await runWalletReconciliationSweep();

      expect(result.usersAudited).toBe(0);
      expect(findManySpy).not.toHaveBeenCalled();
    });
  });

  describe('Sales Month-Lock Date Auto-Adjustment (createSale)', () => {
    const mockUserId = 'user-test-123';
    const mockBusinessId = 'biz-test-123';

    beforeEach(() => {
      jest.spyOn(ownershipLib, 'verifyBusinessOwnership').mockResolvedValue({
        id: mockBusinessId,
        userId: mockUserId,
      } as any);
    });

    test('keeps entered date when month is open', async () => {
      const openDate = new Date('2026-05-15T10:00:00Z');
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue(null as any);

      const createSpy = jest.spyOn(prisma.salesTransaction, 'create').mockResolvedValue({
        id: 'sale-1',
        businessId: mockBusinessId,
        amount: new Prisma.Decimal(5000),
        transactionDate: openDate,
        metadata: {},
      } as any);

      await createSale(mockUserId, mockBusinessId, {
        amount: 5000,
        source: 'manual',
        transactionDate: openDate,
      });

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionDate: openDate,
          }),
        })
      );
    });

    test('auto-adjusts transactionDate to current month when month is locked', async () => {
      const lockedDate = new Date('2026-01-10T10:00:00Z');
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        isLocked: true,
        isFinalized: true,
      } as any);

      const before = new Date();
      let capturedData: any;

      jest.spyOn(prisma.salesTransaction, 'create').mockImplementation((args: any) => {
        capturedData = args.data;
        return Promise.resolve({
          id: 'sale-adjusted-1',
          ...args.data,
        }) as any;
      });

      await createSale(mockUserId, mockBusinessId, {
        amount: 8500,
        source: 'manual',
        transactionDate: lockedDate,
      });

      const after = new Date();

      expect(capturedData).toBeDefined();
      expect(capturedData.transactionDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
      expect(capturedData.transactionDate.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
      expect(capturedData.metadata.dateAdjustedFromLockedMonth).toBe(true);
      expect(capturedData.metadata.originalTransactionDate).toBe(lockedDate.toISOString());
      expect(capturedData.metadata.adjustmentReason).toContain('locked tax period');
    });
  });
});
