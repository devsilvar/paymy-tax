import { describe, test, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/services/settlement/payout-preview.service', () => ({
  getPayoutPreview: jest.fn(),
}));

jest.mock('../../src/lib/ownership', () => ({
  verifyBusinessOwnership: jest.fn(),
  invalidateOwnershipCache: jest.fn(),
}));

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    business: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    salesTransaction: {
      aggregate: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

import { getAccountSummary } from '../../src/services/dva.service';
import { getPayoutPreview } from '../../src/services/settlement/payout-preview.service';
import { verifyBusinessOwnership } from '../../src/lib/ownership';
import prisma from '../../src/lib/prisma';

describe('getAccountSummary Unit Tests (Phase 6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('combines virtual account, transactions, authoritative ledger balance, and monthly sum', async () => {
    const userId = 'user-123';
    const businessId = 'biz-456';

    (verifyBusinessOwnership as jest.Mock).mockResolvedValue({
      id: businessId,
      userId,
      virtualAccountNumber: '9920192831',
      virtualAccountBank: 'Wema Bank',
      ownerName: 'Test Owner',
      businessName: 'Test Business',
    } as any);

    (getPayoutPreview as jest.Mock).mockResolvedValue({
      availableForWithdrawal: 175000.5,
      totalInflows: 200000,
      taxReserve: 15000,
    } as any);

    (prisma.salesTransaction.count as jest.Mock).mockResolvedValue(1 as any);
    (prisma.salesTransaction.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'tx-1',
        amount: 50000,
        status: 'confirmed',
        transactionDate: new Date('2026-09-15T10:00:00Z'),
      },
    ] as any);

    (prisma.salesTransaction.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: 85000 },
    } as any);

    const summary = await getAccountSummary(userId, businessId);

    expect(summary).toBeDefined();
    // 1. Virtual account details
    expect(summary.dva).toEqual({
      status: 'active',
      accountNumber: '9920192831',
      bankName: 'Wema Bank',
      accountName: 'Test Owner',
      businessName: 'Test Business',
    });
    // 2. Transactions list (from getDVATransactions)
    expect(summary.transactions).toHaveLength(1);
    expect(summary.transactions[0].id).toBe('tx-1');
    // 3. Authoritative ledger balance from settlement preview (not client sum)
    expect(summary.ledgerBalance).toBe(175000.5);
    // 4. Server-computed received this month
    expect(summary.receivedThisMonth).toBe(85000);
  });

  test('controller returns 200 with result payload', async () => {
    const { getAccountSummary: getAccountSummaryController } = await import('../../src/controllers/dva.controller');

    const req: any = {
      user: { userId: 'user-123' },
      params: { businessId: 'biz-456' },
    };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    let nextErr: any = null;
    const next = jest.fn((err) => {
      nextErr = err;
    });

    (verifyBusinessOwnership as jest.Mock).mockResolvedValue({
      id: 'biz-456',
      userId: 'user-123',
      virtualAccountNumber: '9920192831',
      virtualAccountBank: 'Wema Bank',
      ownerName: 'Test Owner',
      businessName: 'Test Business',
    } as any);

    (getPayoutPreview as jest.Mock).mockResolvedValue({
      availableForWithdrawal: 100000,
    } as any);

    (prisma.salesTransaction.count as jest.Mock).mockResolvedValue(0 as any);
    (prisma.salesTransaction.findMany as jest.Mock).mockResolvedValue([] as any);
    (prisma.salesTransaction.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: 0 },
    } as any);

    await new Promise<void>((resolve, reject) => {
      res.json = jest.fn((val) => {
        resolve();
        return res;
      });
      getAccountSummaryController(req, res, (err) => {
        next(err);
        reject(err);
      });
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          ledgerBalance: 100000,
        }),
      })
    );
  });
});
