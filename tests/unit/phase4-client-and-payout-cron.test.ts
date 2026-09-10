import { describe, test, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';

const mockVerifyTransfer = jest.fn();
const mockPaymentProvider = {
  verifyTransfer: mockVerifyTransfer,
};

jest.mock('../../src/lib/payment', () => ({
  getPaymentProvider: () => mockPaymentProvider,
}));

jest.mock('../../src/services/wallet.service', () => ({
  WalletService: {
    settlePayoutDebit: jest.fn().mockResolvedValue({} as any),
    releaseLockedFunds: jest.fn().mockResolvedValue({ success: true } as any),
  },
}));

jest.mock('../../src/core/events/event-bus', () => ({
  eventBus: {
    emit: jest.fn(),
  },
}));

jest.mock('../../src/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined as any),
}));

jest.mock('../../src/services/reminder.service', () => ({
  createReminderOnce: jest.fn().mockResolvedValue({ id: 'rem-1' } as any),
}));

jest.mock('../../src/services/reminder/reminder-generation.service', () => ({
  createReminderOnce: jest.fn().mockResolvedValue({ id: 'rem-1' } as any),
}));

import prisma from '../../src/lib/prisma';
import { runPayoutReconciliationSweep } from '../../src/jobs/payout-reconciliation.cron';
import { WalletService } from '../../src/services/wallet.service';
import { eventBus } from '../../src/core/events/event-bus';
import { createReminderOnce } from '../../src/services/reminder/reminder-generation.service';

describe('Phase 4 — Client Concurrency & Asynchronous Workflows (Payout Reconciliation Cron)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('skips reconciliation when transaction advisory lock is already held', async () => {
    jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ locked: false }]),
      };
      return callback(mockTx);
    });

    const result = await runPayoutReconciliationSweep();
    expect(result.payoutsAudited).toBe(0);
    expect(mockVerifyTransfer).not.toHaveBeenCalled();
  });

  test('reconciles successful Paystack transfer and settles wallet debit', async () => {
    const mockStuckPayout = {
      id: 'payout-101',
      businessId: 'biz-1',
      transferReference: 'PO-20260910-ABCDE',
      paystackTransferCode: 'TRF_test123',
      amount: 50000,
      fee: 25,
      netAmount: 49975,
      destinationBankName: 'Access Bank',
      status: 'processing',
      business: {
        id: 'biz-1',
        userId: 'user-1',
        businessName: 'Acme Enterprises',
      },
    };

    jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([mockStuckPayout as any]);
    jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue({ status: 'processing' } as any);
    const mockUpdate = jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);

    mockVerifyTransfer.mockResolvedValue({
      status: 'success',
      reference: 'PO-20260910-ABCDE',
    });

    const result = await runPayoutReconciliationSweep({ bypassLock: true });

    expect(result.payoutsAudited).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    expect(mockVerifyTransfer).toHaveBeenCalledWith('PO-20260910-ABCDE');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'payout-101' },
      data: {
        status: 'completed',
        completedAt: expect.any(Date),
      },
    });

    expect(WalletService.settlePayoutDebit).toHaveBeenCalledWith({
      userId: 'user-1',
      businessId: 'biz-1',
      amount: 50000,
      fee: 0,
      reference: 'PO-20260910-ABCDE',
      linkedPayoutId: 'payout-101',
      description: expect.stringContaining('Access Bank'),
    });

    expect(eventBus.emit).toHaveBeenCalledWith('payout.completed', {
      userId: 'user-1',
      payoutId: 'payout-101',
      amount: 50000,
      reference: 'PO-20260910-ABCDE',
    });

    expect(createReminderOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        reminderType: 'payout_completed',
        referenceId: 'payout-101',
      })
    );
  });

  test('reconciles failed Paystack transfer and releases locked funds', async () => {
    const mockStuckPayout = {
      id: 'payout-102',
      businessId: 'biz-1',
      transferReference: 'PO-20260910-FAIL',
      paystackTransferCode: 'TRF_fail123',
      amount: 25000,
      fee: 25,
      netAmount: 24975,
      status: 'processing',
      business: {
        id: 'biz-1',
        userId: 'user-1',
        businessName: 'Acme Enterprises',
      },
    };

    jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([mockStuckPayout as any]);
    jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue({ status: 'processing' } as any);
    const mockUpdate = jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);

    mockVerifyTransfer.mockResolvedValue({
      status: 'failed',
      gatewayResponse: 'Destination account invalid',
      reference: 'PO-20260910-FAIL',
    });

    const result = await runPayoutReconciliationSweep({ bypassLock: true });

    expect(result.payoutsAudited).toBe(1);
    expect(result.completedCount).toBe(0);
    expect(result.failedCount).toBe(1);

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'payout-102' },
      data: {
        status: 'failed',
        failureReason: 'Destination account invalid',
      },
    });

    expect(WalletService.releaseLockedFunds).toHaveBeenCalledWith({
      userId: 'user-1',
      amount: 25000,
      fee: 0,
    });

    expect(createReminderOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        reminderType: 'payout_failed',
        referenceId: 'payout-102',
      })
    );
  });

  test('isolates per-payout errors so a single network failure does not crash the sweep', async () => {
    const payoutError = {
      id: 'payout-err',
      businessId: 'biz-1',
      transferReference: 'PO-ERR',
      paystackTransferCode: 'TRF_ERR',
      amount: 10000,
      status: 'processing',
      business: { id: 'biz-1', userId: 'user-1' },
    };

    const payoutOk = {
      id: 'payout-ok',
      businessId: 'biz-1',
      transferReference: 'PO-OK',
      paystackTransferCode: 'TRF_OK',
      amount: 15000,
      status: 'processing',
      business: { id: 'biz-1', userId: 'user-1' },
    };

    jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([payoutError as any, payoutOk as any]);
    jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue({ status: 'processing' } as any);
    jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);

    mockVerifyTransfer
      .mockRejectedValueOnce(new Error('Gateway timeout'))
      .mockResolvedValueOnce({ status: 'success' });

    const result = await runPayoutReconciliationSweep({ bypassLock: true });

    expect(result.payoutsAudited).toBe(2);
    expect(result.completedCount).toBe(1); // Second payout completed despite first error
    expect(mockVerifyTransfer).toHaveBeenCalledTimes(2);
  });
});
