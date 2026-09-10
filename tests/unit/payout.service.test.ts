import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
  withdrawBalance,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
} from '@/modules/wallet/services/payout.service';
import * as settlementService from '@/services/settlement.service';
import * as withdrawalActorModule from '@/shared/helpers/withdrawal-actor';
import * as pinService from '@/services/pin.service';
import * as paymentModule from '@/lib/payment';
import * as auditModule from '@/lib/audit';
import { WalletService } from '@/services/wallet.service';
import { eventBus } from '@/core/events/event-bus';
import prisma from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

describe('PayoutService Unit Suite', () => {
  const mockUserId = 'usr-payout-001';
  const mockBusinessId = 'biz-payout-001';

  beforeEach(() => {
    jest.restoreAllMocks();
    eventBus.removeAllListeners();
    jest.spyOn(auditModule, 'logAudit').mockReturnValue(undefined as any);
  });

  describe('withdrawBalance', () => {
    test('throws INSUFFICIENT_FUNDS when withdrawal amount exceeds available balance', async () => {
      jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue({
        id: mockBusinessId,
        userId: mockUserId,
        businessName: 'Apex Business',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        settlementBankName: 'GTBank',
        user: {
          id: mockUserId,
          transactionPin: '$2b$12$hashed...',
          pinLockedUntil: null,
          pinAttempts: 0,
        },
      } as any);

      jest.spyOn(settlementService, 'getPayoutPreview').mockResolvedValue({
        availableForWithdrawal: 5000,
        settlementAccount: {
          isConnected: true,
          accountNumber: '0123456789',
          bankCode: '058',
          bankName: 'GTBank',
          accountName: 'TEST USER',
        },
      } as any);

      jest.spyOn(pinService, 'verifyPin').mockResolvedValue(undefined as any);

      const mockTx: any = {
        $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: true }]),
      };
      jest.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb(mockTx);
      });

      await expect(
        withdrawBalance(mockUserId, mockBusinessId, {
          amount: 10000,
          pin: '1234',
        })
      ).rejects.toThrow(AppError);

      try {
        await withdrawBalance(mockUserId, mockBusinessId, {
          amount: 10000,
          pin: '1234',
        });
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INSUFFICIENT_FUNDS');
      }
    });

    test('throws SETTLEMENT_ACCOUNT_REQUIRED when settlement account is not connected', async () => {
      jest.spyOn(withdrawalActorModule, 'getWithdrawalActor').mockResolvedValue({
        id: mockBusinessId,
        userId: mockUserId,
        businessName: 'Apex Business',
        settlementAccountNumber: null,
        settlementBankCode: null,
        user: {
          id: mockUserId,
          transactionPin: '$2b$12$hashed...',
          pinLockedUntil: null,
          pinAttempts: 0,
        },
      } as any);

      jest.spyOn(settlementService, 'getPayoutPreview').mockResolvedValue({
        availableForWithdrawal: 50000,
        settlementAccount: {
          isConnected: false,
        },
      } as any);

      jest.spyOn(pinService, 'verifyPin').mockResolvedValue(undefined as any);

      await expect(
        withdrawBalance(mockUserId, mockBusinessId, {
          amount: 10000,
          pin: '1234',
        })
      ).rejects.toThrow('No settlement bank connected. Please connect your commercial bank account first.');
    });
  });

  describe('adminRejectWithdrawal', () => {
    test('releases reserved funds and updates payout status to rejected', async () => {
      const mockPayout = {
        id: 'payout-123',
        businessId: mockBusinessId,
        amount: 20000,
        fee: 50,
        status: 'pending',
        transferReference: 'PO-20260909-ABCD',
        business: {
          id: mockBusinessId,
          userId: mockUserId,
          businessName: 'Apex Business',
        },
      };

      jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue(mockPayout as any);
      jest.spyOn(prisma.settlementPayout, 'updateMany').mockResolvedValue({ count: 1 } as any);
      jest.spyOn(WalletService, 'releaseLockedFunds').mockResolvedValue({} as any);

      const result = await adminRejectWithdrawal(
        'admin-001',
        'payout-123',
        'Suspicious activity on account'
      );

      expect(prisma.settlementPayout.updateMany).toHaveBeenCalledWith({
        where: { id: 'payout-123', status: 'pending' },
        data: expect.objectContaining({
          status: 'failed',
          failureReason: 'Rejected by admin: Suspicious activity on account',
        }),
      });
      expect(WalletService.releaseLockedFunds).toHaveBeenCalledWith({
        userId: mockUserId,
        amount: 20000,
        fee: 0,
      });
      expect(result.status).toBe('failed');
    });
  });

  describe('Event Bus Dispatch on Payout Completion', () => {
    test('emits payout.completed event post-commit when transfer completes successfully', async () => {
      const mockPayout = {
        id: 'payout-456',
        businessId: mockBusinessId,
        amount: 15000,
        fee: 50,
        netAmount: 14950,
        status: 'pending',
        recipientCode: 'RCP_123',
        transferReference: 'PO-20260909-WXYZ',
        destinationBankCode: '058',
        destinationAccountNum: '0123456789',
        destinationAccountName: 'Apex Corp',
        business: {
          id: mockBusinessId,
          userId: mockUserId,
          businessName: 'Apex Corp',
          user: {
            id: mockUserId,
            email: 'ceo@apex.ng',
          },
        },
      };

      jest.spyOn(prisma.settlementPayout, 'findUnique').mockResolvedValue(mockPayout as any);
      jest.spyOn(settlementService, 'getPayoutPreview').mockResolvedValue({
        availableForWithdrawal: 100000,
      } as any);

      const mockTx: any = {
        $queryRaw: jest.fn<any>().mockResolvedValue([{ locked: true }]),
        settlementPayout: {
          updateMany: jest.fn<any>().mockResolvedValue({ count: 1 }),
        },
      };

      jest.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb(mockTx);
      });

      const mockProvider = {
        createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_123' }),
        initiateTransfer: jest.fn<any>().mockResolvedValue({
          transferCode: 'TRF_test123',
          status: 'success',
        }),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      jest.spyOn(WalletService, 'checkLivePaystackBalance').mockResolvedValue({
        canPayout: true,
        deficit: 0,
        paystackBalance: 500000,
      } as any);
      jest.spyOn(WalletService, 'settlePayoutDebit').mockResolvedValue({} as any);

      jest.spyOn(prisma.settlementPayout, 'update').mockResolvedValue({
        ...mockPayout,
        status: 'completed',
      } as any);

      const eventPayloads: any[] = [];
      eventBus.on('payout.completed', (payload) => {
        eventPayloads.push(payload);
      });

      await adminApproveWithdrawal('admin-001', 'payout-456');

      // Allow setImmediate event loop cycle for post-commit event dispatch
      await new Promise((resolve) => setImmediate(resolve));

      expect(eventPayloads).toHaveLength(1);
      expect(eventPayloads[0]).toEqual({
        userId: mockUserId,
        payoutId: 'payout-456',
        amount: 15000,
        reference: 'PO-20260909-WXYZ',
      });
    });
  });
});
