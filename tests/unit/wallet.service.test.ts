import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { WalletService } from '../../src/services/wallet.service';
import { AppError } from '../../src/middleware/errorHandler';
import { Prisma, WalletTxType } from '@prisma/client';
import axios from 'axios';
import { config } from '../../src/config';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('WalletService Unit Tests', () => {
  let mockTx: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockTx = {
      walletBalance: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      walletTransaction: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
  });

  describe('getOrCreateWallet', () => {
    test('returns existing wallet if found', async () => {
      const existing = {
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(5000),
        lockedBalance: new Prisma.Decimal(1000),
        currency: 'NGN',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTx.walletBalance.findUnique.mockResolvedValue(existing);

      const result = await WalletService.getOrCreateWallet('user-1', mockTx);

      expect(mockTx.walletBalance.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(mockTx.walletBalance.create).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    test('creates new wallet with zero balances if not found', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue(null);
      const created = {
        id: 'wallet-new',
        userId: 'user-2',
        balance: new Prisma.Decimal(0),
        lockedBalance: new Prisma.Decimal(0),
        currency: 'NGN',
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTx.walletBalance.create.mockResolvedValue(created);

      const result = await WalletService.getOrCreateWallet('user-2', mockTx);

      expect(mockTx.walletBalance.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-2' },
      });
      expect(mockTx.walletBalance.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-2',
          balance: expect.any(Prisma.Decimal),
          lockedBalance: expect.any(Prisma.Decimal),
          currency: 'NGN',
          version: 0,
        },
      });
      expect(result).toBe(created);
    });

    test('handles P2002 race condition gracefully by querying again', async () => {
      mockTx.walletBalance.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'wallet-raced',
          userId: 'user-race',
          balance: new Prisma.Decimal(0),
          lockedBalance: new Prisma.Decimal(0),
          currency: 'NGN',
          version: 0,
        });

      const p2002Error: any = new Error('Unique constraint failed');
      p2002Error.code = 'P2002';
      mockTx.walletBalance.create.mockRejectedValue(p2002Error);

      const result = await WalletService.getOrCreateWallet('user-race', mockTx);

      expect(result.id).toBe('wallet-raced');
      expect(mockTx.walletBalance.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('getWalletBalance', () => {
    test('computes availableBalance as balance - lockedBalance', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(15000),
        lockedBalance: new Prisma.Decimal(5000),
        currency: 'NGN',
        version: 2,
        updatedAt: new Date('2026-09-09T10:00:00Z'),
      });

      const dto = await WalletService.getWalletBalance('user-1', mockTx);

      expect(dto.balance).toBe(15000);
      expect(dto.lockedBalance).toBe(5000);
      expect(dto.availableBalance).toBe(10000);
      expect(dto.currency).toBe('NGN');
      expect(dto.version).toBe(2);
    });

    test('clamps availableBalance to 0 if lockedBalance exceeds balance', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-2',
        userId: 'user-2',
        balance: new Prisma.Decimal(2000),
        lockedBalance: new Prisma.Decimal(3000),
        currency: 'NGN',
        version: 3,
        updatedAt: new Date(),
      });

      const dto = await WalletService.getWalletBalance('user-2', mockTx);

      expect(dto.balance).toBe(2000);
      expect(dto.lockedBalance).toBe(3000);
      expect(dto.availableBalance).toBe(0);
    });
  });

  describe('creditWallet', () => {
    test('returns existing transaction and alreadyProcessed: true when idempotencyKey matches', async () => {
      const existingTx = {
        id: 'tx-existing',
        idempotencyKey: 'idem-123',
        amount: new Prisma.Decimal(5000),
      };
      mockTx.walletTransaction.findUnique.mockResolvedValueOnce(existingTx);
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(5000),
      });

      const res = await WalletService.creditWallet(
        {
          userId: 'user-1',
          amount: 5000,
          reference: 'ref-123',
          source: 'dva_transfer',
          idempotencyKey: 'idem-123',
        },
        mockTx
      );

      expect(res.alreadyProcessed).toBe(true);
      expect(res.transaction).toBe(existingTx);
      expect(mockTx.walletBalance.update).not.toHaveBeenCalled();
    });

    test('returns existing transaction when reference matches', async () => {
      const existingTx = {
        id: 'tx-ref',
        reference: 'ref-unique',
        amount: new Prisma.Decimal(10000),
      };
      mockTx.walletTransaction.findUnique.mockResolvedValueOnce(existingTx);
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
      });

      const res = await WalletService.creditWallet(
        {
          userId: 'user-1',
          amount: 10000,
          reference: 'ref-unique',
          source: 'dva_transfer',
        },
        mockTx
      );

      expect(res.alreadyProcessed).toBe(true);
      expect(res.transaction).toBe(existingTx);
      expect(mockTx.walletBalance.update).not.toHaveBeenCalled();
    });

    test('returns existing transaction when linkedSaleId matches', async () => {
      mockTx.walletTransaction.findUnique
        .mockResolvedValueOnce(null) // reference
        .mockResolvedValueOnce({
          id: 'tx-linked-sale',
          linkedSaleId: 'sale-999',
        });
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
      });

      const res = await WalletService.creditWallet(
        {
          userId: 'user-1',
          amount: 25000,
          reference: 'ref-sale-999',
          source: 'dva_transfer',
          linkedSaleId: 'sale-999',
        },
        mockTx
      );

      expect(res.alreadyProcessed).toBe(true);
      expect(mockTx.walletBalance.update).not.toHaveBeenCalled();
    });

    test('atomically updates balance and creates transaction ledger entry', async () => {
      mockTx.walletTransaction.findUnique.mockResolvedValue(null);
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(10000),
      });

      const updatedWallet = {
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(19500),
        version: 1,
      };
      mockTx.walletBalance.update.mockResolvedValue(updatedWallet);

      const createdTx = {
        id: 'tx-new',
        walletId: 'wallet-1',
        userId: 'user-1',
        amount: new Prisma.Decimal(10000),
        fee: new Prisma.Decimal(500),
        netAmount: new Prisma.Decimal(9500),
        reference: 'credit-001',
        source: 'dva_transfer',
      };
      mockTx.walletTransaction.create.mockResolvedValue(createdTx);

      const res = await WalletService.creditWallet(
        {
          userId: 'user-1',
          amount: 10000,
          fee: 500,
          reference: 'credit-001',
          source: 'dva_transfer',
          description: 'Payment from customer',
        },
        mockTx
      );

      expect(res.alreadyProcessed).toBe(false);
      expect(mockTx.walletBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          balance: { increment: expect.any(Prisma.Decimal) },
          version: { increment: 1 },
          updatedAt: expect.any(Date),
        },
      });
      expect(mockTx.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          walletId: 'wallet-1',
          userId: 'user-1',
          type: WalletTxType.credit,
          reference: 'credit-001',
          source: 'dva_transfer',
          description: 'Payment from customer',
        }),
      });
    });
  });

  describe('reserveFunds', () => {
    test('throws 400 INSUFFICIENT_FUNDS when available balance is too low', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(10000),
        lockedBalance: new Prisma.Decimal(8000), // available = 2000
      });

      await expect(
        WalletService.reserveFunds(
          {
            userId: 'user-1',
            amount: 5000, // 5000 + 50 fee > 2000 available
            fee: 50,
            reference: 'payout-ref-1',
          },
          mockTx
        )
      ).rejects.toThrow(AppError);

      expect(mockTx.walletBalance.update).not.toHaveBeenCalled();
    });

    test('increments lockedBalance when available balance is sufficient', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(50000),
        lockedBalance: new Prisma.Decimal(10000), // available = 40000
      });

      const updatedWallet = {
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(50000),
        lockedBalance: new Prisma.Decimal(30050), // 10000 + 20000 + 50
        version: 2,
      };
      mockTx.walletBalance.update.mockResolvedValue(updatedWallet);

      const result = await WalletService.reserveFunds(
        {
          userId: 'user-1',
          amount: 20000,
          fee: 50,
          reference: 'payout-ref-2',
        },
        mockTx
      );

      expect(result.success).toBe(true);
      expect(result.lockedAmount).toBe(20050);
      expect(mockTx.walletBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          lockedBalance: { increment: expect.any(Prisma.Decimal) },
          version: { increment: 1 },
          updatedAt: expect.any(Date),
        },
      });
    });
  });

  describe('settlePayoutDebit', () => {
    test('decrements both balance and lockedBalance and records payout transaction', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(50000),
        lockedBalance: new Prisma.Decimal(20050),
      });

      const updatedWallet = {
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(29950),
        lockedBalance: new Prisma.Decimal(0),
        version: 3,
      };
      mockTx.walletBalance.update.mockResolvedValue(updatedWallet);

      const createdTx = {
        id: 'tx-payout',
        type: WalletTxType.payout,
        reference: 'transfer-ref-1',
      };
      mockTx.walletTransaction.create.mockResolvedValue(createdTx);

      const result = await WalletService.settlePayoutDebit(
        {
          userId: 'user-1',
          businessId: 'biz-1',
          amount: 20000,
          fee: 50,
          reference: 'transfer-ref-1',
          linkedPayoutId: 'payout-123',
        },
        mockTx
      );

      expect(mockTx.walletBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          balance: { decrement: expect.any(Prisma.Decimal) },
          lockedBalance: { decrement: expect.any(Prisma.Decimal) },
          version: { increment: 1 },
          updatedAt: expect.any(Date),
        },
      });
      expect(mockTx.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: WalletTxType.payout,
          amount: expect.any(Prisma.Decimal),
          fee: expect.any(Prisma.Decimal),
          netAmount: expect.any(Prisma.Decimal),
          reference: 'transfer-ref-1',
          linkedPayoutId: 'payout-123',
        }),
      });
      expect(result.wallet).toBe(updatedWallet);
      expect(result.transaction).toBe(createdTx);
    });
  });

  describe('releaseLockedFunds', () => {
    test('decrements lockedBalance without altering balance', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(50000),
        lockedBalance: new Prisma.Decimal(20050),
      });

      const updatedWallet = {
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(50000),
        lockedBalance: new Prisma.Decimal(0),
        version: 4,
      };
      mockTx.walletBalance.update.mockResolvedValue(updatedWallet);

      const result = await WalletService.releaseLockedFunds(
        {
          userId: 'user-1',
          amount: 20000,
          fee: 50,
        },
        mockTx
      );

      expect(result.success).toBe(true);
      expect(result.releasedAmount).toBe(20050);
      expect(mockTx.walletBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          lockedBalance: { decrement: expect.any(Prisma.Decimal) },
          version: { increment: 1 },
          updatedAt: expect.any(Date),
        },
      });
    });

    test('clamps decrement if lockedBalance is less than requested release', async () => {
      mockTx.walletBalance.findUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        balance: new Prisma.Decimal(50000),
        lockedBalance: new Prisma.Decimal(5000), // lower than 10000
      });

      mockTx.walletBalance.update.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        lockedBalance: new Prisma.Decimal(0),
      });

      const result = await WalletService.releaseLockedFunds(
        {
          userId: 'user-1',
          amount: 10000,
          fee: 0,
        },
        mockTx
      );

      expect(result.releasedAmount).toBe(5000);
    });
  });

  describe('checkLivePaystackBalance', () => {
    const originalSecretKey = config.paystack.secretKey;
    const originalMock = config.paystack.mockBankResolution;

    afterEach(() => {
      (config.paystack as any).secretKey = originalSecretKey;
      (config.paystack as any).mockBankResolution = originalMock;
    });

    test('bypasses live API call and returns true in test/mock environment', async () => {
      (config.paystack as any).secretKey = 'sk_test_mockkey';
      (config.paystack as any).mockBankResolution = true;

      const result = await WalletService.checkLivePaystackBalance(100000);

      expect(result.canPayout).toBe(true);
      expect(result.deficit).toBe(0);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    test('queries Paystack API in live mode and detects sufficient balance', async () => {
      (config.paystack as any).secretKey = 'sk_live_realkey';
      (config.paystack as any).mockBankResolution = false;

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          data: [
            { currency: 'NGN', balance: 50000000 }, // ₦500,000.00
            { currency: 'USD', balance: 10000 },
          ],
        },
      });

      const result = await WalletService.checkLivePaystackBalance(200000); // ₦200,000.00

      expect(result.canPayout).toBe(true);
      expect(result.paystackBalanceNaira).toBe(500000);
      expect(result.deficit).toBe(0);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.paystack.co/balance',
        expect.objectContaining({
          headers: { Authorization: 'Bearer sk_live_realkey' },
        })
      );
    });

    test('queries Paystack API in live mode and fails when balance is deficient', async () => {
      (config.paystack as any).secretKey = 'sk_live_realkey';
      (config.paystack as any).mockBankResolution = false;

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          data: [
            { currency: 'NGN', balance: 5000000 }, // ₦50,000.00
          ],
        },
      });

      const result = await WalletService.checkLivePaystackBalance(100000); // ₦100,000.00

      expect(result.canPayout).toBe(false);
      expect(result.paystackBalanceNaira).toBe(50000);
      expect(result.deficit).toBe(50000);
    });

    test('fails closed when Paystack API throws an error', async () => {
      (config.paystack as any).secretKey = 'sk_live_realkey';
      (config.paystack as any).mockBankResolution = false;

      mockedAxios.get.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await WalletService.checkLivePaystackBalance(50000);

      expect(result.canPayout).toBe(false);
      expect(result.paystackBalanceNaira).toBe(0);
      expect(result.deficit).toBe(50000);
    });
  });
});
