import { describe, test, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import { AppError } from '../../src/middleware/errorHandler';
import { isAmbiguousTransferError } from '../../src/lib/payment/errors';

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
import { logAudit } from '../../src/lib/audit';

describe('Blockers 1 & 2: Payout Ambiguity & Transport Timeout Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('isAmbiguousTransferError classification', () => {
    test('identifies PAYSTACK_TIMEOUT (504) as ambiguous', () => {
      const err = new AppError(504, 'Paystack gateway timed out', 'PAYSTACK_TIMEOUT');
      expect(isAmbiguousTransferError(err)).toBe(true);
    });

    test('identifies PAYSTACK_TRANSPORT_ERROR (502) as ambiguous', () => {
      const err = new AppError(502, 'Transport reset', 'PAYSTACK_TRANSPORT_ERROR');
      expect(isAmbiguousTransferError(err)).toBe(true);
    });

    test('identifies 5xx gateway errors as ambiguous', () => {
      const err500 = new AppError(500, 'Internal server error', 'PAYSTACK_ERROR');
      const err503 = new AppError(503, 'Service unavailable', 'PAYSTACK_ERROR');
      expect(isAmbiguousTransferError(err500)).toBe(true);
      expect(isAmbiguousTransferError(err503)).toBe(true);
    });

    test('identifies TimeoutError / AbortError as ambiguous', () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';

      expect(isAmbiguousTransferError(timeoutErr)).toBe(true);
      expect(isAmbiguousTransferError(abortErr)).toBe(true);
    });

    test('treats deterministic 4xx Paystack errors as non-ambiguous', () => {
      const invalidNubanErr = new AppError(400, 'Could not resolve account', 'PAYSTACK_ERROR', {
        paystackCode: 'account_not_found',
      });
      const authErr = new AppError(401, 'Unauthorized', 'PAYSTACK_ERROR');

      expect(isAmbiguousTransferError(invalidNubanErr)).toBe(false);
      expect(isAmbiguousTransferError(authErr)).toBe(false);
    });

    test('treats arbitrary non-transport errors as non-ambiguous', () => {
      const genericErr = new Error('Database syntax error');
      expect(isAmbiguousTransferError(genericErr)).toBe(false);
    });
  });

  describe('Payout Reconciliation Cron: 404 NOT_FOUND & Uncoded Transfers', () => {
    test('marks payout as failed and releases funds if 404 from Paystack and initiated >30 min ago', async () => {
      const thirtyFiveMinutesAgo = new Date(Date.now() - 35 * 60 * 1000);
      const mockOldPayout = {
        id: 'payout-old-404',
        businessId: 'biz-1',
        transferReference: 'PO-20260910-OLD404',
        paystackTransferCode: null, // Timed out before transfer code was assigned
        amount: 30000,
        fee: 25,
        netAmount: 29975,
        destinationBankName: 'Zenith Bank',
        status: 'processing',
        initiatedAt: thirtyFiveMinutesAgo,
        business: {
          id: 'biz-1',
          userId: 'user-1',
          businessName: 'Acme Enterprises',
        },
      };

      jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([mockOldPayout as any]);
      jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue({ status: 'processing' } as any);
      const mockUpdate = jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);

      // Simulate Paystack returning 404 PAYSTACK_ERROR
      const notFoundErr = new AppError(400, 'Transfer reference not found', 'PAYSTACK_ERROR', {
        httpStatus: 404,
      });
      mockVerifyTransfer.mockRejectedValue(notFoundErr);

      const result = await runPayoutReconciliationSweep({ bypassLock: true });

      expect(result.payoutsAudited).toBe(1);
      expect(result.completedCount).toBe(0);
      expect(result.failedCount).toBe(1);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'payout-old-404' },
        data: expect.objectContaining({
          status: 'failed',
          failureReason: expect.stringContaining('Transfer reference not found'),
        }),
      });

      expect(WalletService.releaseLockedFunds).toHaveBeenCalledWith({
        userId: 'user-1',
        amount: 30000,
        fee: 0,
      });

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: 'biz-1',
          action: 'settlement.payout_reconciled_not_found',
        })
      );
    });

    test('leaves payout in processing if 404 from Paystack but initiated <30 min ago (propagation delay)', async () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const mockRecentPayout = {
        id: 'payout-recent-404',
        businessId: 'biz-1',
        transferReference: 'PO-20260910-RECENT404',
        paystackTransferCode: null,
        amount: 15000,
        fee: 25,
        netAmount: 14975,
        destinationBankName: 'Guaranty Trust Bank',
        status: 'processing',
        initiatedAt: fifteenMinutesAgo,
        business: {
          id: 'biz-1',
          userId: 'user-1',
          businessName: 'Acme Enterprises',
        },
      };

      jest.spyOn(prisma.settlementPayout, 'findMany').mockResolvedValue([mockRecentPayout as any]);
      jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue({ status: 'processing' } as any);
      const mockUpdate = jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({} as any);

      const notFoundErr = new AppError(400, 'Transfer reference not found', 'PAYSTACK_ERROR', {
        httpStatus: 404,
      });
      mockVerifyTransfer.mockRejectedValue(notFoundErr);

      const result = await runPayoutReconciliationSweep({ bypassLock: true });

      expect(result.payoutsAudited).toBe(1);
      expect(result.completedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.pendingCount).toBe(1);

      // MUST NOT update status or release funds yet
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(WalletService.releaseLockedFunds).not.toHaveBeenCalled();
    });
  });
});
