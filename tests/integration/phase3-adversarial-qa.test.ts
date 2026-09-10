import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import crypto from 'crypto';
import config from '../../src/config';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import * as settlementService from '../../src/services/settlement.service';
import * as payoutService from '../../src/modules/wallet/services/payout.service';
import * as bankResolutionService from '../../src/modules/wallet/services/bank-resolution.service';
import * as walletModule from '../../src/modules/wallet';
import { WalletService } from '../../src/services/wallet.service';
import { processWebhook } from '../../src/services/payment.service';
import { TypedEventBus, AppDomainEvents, eventBus } from '../../src/core/events/event-bus';
import * as paymentModule from '../../src/lib/payment';
import bcrypt from 'bcrypt';
import { AppError } from '../../src/middleware/errorHandler';

describe('Phase 3 Adversarial QA & Architecture Verification Suite', () => {
  jest.setTimeout(60000);

  let testUser: any;
  let testBiz: any;
  let adminUser: any;
  const rawPin = '1234';

  beforeAll(async () => {
    await clearDatabase();
    adminUser = await testDb.user.create({
      data: {
        email: `admin-qa-${Date.now()}@example.com`,
        passwordHash: '$2b$12$hashedpassword',
        role: 'admin',
        isVerified: true,
        isActive: true,
      },
    });
  }, 30000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 30000);

  beforeEach(() => {
    eventBus.removeAllListeners();
  });

  async function setupUserAndBiz(nameSuffix: string = '') {
    const pinHash = await bcrypt.hash(rawPin, 10);
    const rand = `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const user = await testDb.user.create({
      data: {
        email: `qa-phase3-${rand}@example.com`,
        passwordHash: '$2b$12$hashedpassword',
        transactionPin: pinHash,
        isVerified: true,
        isActive: true,
      },
    });

    const biz = await testDb.business.create({
      data: {
        userId: user.id,
        merchantId: `Q${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        businessName: `QA Phase3 ${nameSuffix}`,
        ownerName: 'QA Architect',
        taxId: `TAX-${rand}`,
        businessType: 'Consulting',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        settlementBankName: 'GTBank',
        settlementAccountName: `QA PHASE3 ${nameSuffix}`.toUpperCase(),
      },
    });

    return { user, biz };
  }

  describe('1. Strangler Fig Architectural Parity & Façade Integrity', () => {
    test('settlement.service façade delegates strictly to bounded services without mutation', () => {
      // Bank resolution functions
      expect(settlementService.resolveSettlementAccount).toBe(bankResolutionService.resolveSettlementAccount);
      expect(settlementService.connectSettlementBank).toBe(bankResolutionService.connectSettlementBank);

      // Payout functions
      expect(settlementService.withdrawBalance).toBe(payoutService.withdrawBalance);
      expect(settlementService.listPayoutHistory).toBe(payoutService.listPayoutHistory);
      expect(settlementService.adminListWithdrawalRequests).toBe(payoutService.adminListWithdrawalRequests);
      expect(settlementService.adminApproveWithdrawal).toBe(payoutService.adminApproveWithdrawal);
      expect(settlementService.adminRejectWithdrawal).toBe(payoutService.adminRejectWithdrawal);
      expect(settlementService.adminRequeryWithdrawal).toBe(payoutService.adminRequeryWithdrawal);
      expect(settlementService.adminToggleAutoPayout).toBe(payoutService.adminToggleAutoPayout);

      // Verify module aggregation export
      expect(walletModule.withdrawBalance).toBe(payoutService.withdrawBalance);
      expect(walletModule.resolveSettlementAccount).toBe(bankResolutionService.resolveSettlementAccount);
      expect(walletModule.WalletService).toBe(WalletService);
    });
  });

  describe('2. Post-Commit Domain Event Bus Error Boundaries & Isolation', () => {
    test('survives synchronous exceptions, asynchronous rejections, and delivers to remaining listeners', async () => {
      const bus = new TypedEventBus();
      const receivedEvents: string[] = [];

      // Listener 1: Throws synchronously
      bus.on('payout.completed', () => {
        throw new Error('Explosive synchronous crash in third-party webhook sender');
      });

      // Listener 2: Rejects asynchronously
      bus.on('payout.completed', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('Explosive asynchronous rejection in analytics worker');
      });

      // Listener 3: Healthy listener
      bus.on('payout.completed', (payload) => {
        receivedEvents.push(payload.payoutId);
      });

      expect(() => {
        bus.emit('payout.completed', {
          userId: 'usr-event-1',
          payoutId: 'payout-test-999',
          amount: 50000,
          reference: 'PO-REF-999',
        });
      }).not.toThrow();

      // Allow event loop to process async handlers
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toBe('payout-test-999');
    });

    test('verifies all 5 domain event contracts accept valid strongly-typed payloads', async () => {
      const bus = new TypedEventBus();
      const fired: string[] = [];

      bus.on('order.payment_confirmed', () => fired.push('order.payment_confirmed'));
      bus.on('invoice.paid', () => fired.push('invoice.paid'));
      bus.on('dva.transfer_received', () => fired.push('dva.transfer_received'));
      bus.on('wallet.credited', () => fired.push('wallet.credited'));
      bus.on('payout.completed', () => fired.push('payout.completed'));

      bus.emit('order.payment_confirmed', {
        orderId: 'ord-1',
        storeId: 'store-1',
        businessId: 'biz-1',
        userId: 'usr-1',
        amount: 15000,
        orderNumber: 'ORD-001',
        customerName: 'Amina',
        customerPhone: '08012345678',
        items: [{ name: 'Item 1', quantity: 1, unitPrice: 15000 }],
      });

      bus.emit('invoice.paid', {
        invoiceId: 'inv-1',
        businessId: 'biz-1',
        userId: 'usr-1',
        amount: 25000,
        invoiceNumber: 'INV-001',
        customerName: 'Chidi',
        paymentDate: new Date(),
      });

      bus.emit('dva.transfer_received', {
        accountNumber: '9988776655',
        amount: 30000,
        reference: 'DVA-REF-001',
        rawEvent: {},
      });

      bus.emit('wallet.credited', {
        userId: 'usr-1',
        amount: 30000,
        transactionId: 'tx-001',
      });

      bus.emit('payout.completed', {
        userId: 'usr-1',
        payoutId: 'payout-001',
        amount: 20000,
        reference: 'PO-REF-001',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fired).toEqual([
        'order.payment_confirmed',
        'invoice.paid',
        'dva.transfer_received',
        'wallet.credited',
        'payout.completed',
      ]);
    });
  });

  describe('3. Bank Resolution Payout Lock Enforcement', () => {
    test('blocks unauthorized account modification when payoutChangePermitted is false', async () => {
      const { user, biz } = await setupUserAndBiz('lock-1');
      await expect(
        bankResolutionService.connectSettlementBank(user.id, biz.id, {
          accountNumber: '9988112233',
          bankCode: '033',
          bankName: 'UBA',
          pin: rawPin,
        })
      ).rejects.toThrow(AppError);

      try {
        await bankResolutionService.connectSettlementBank(user.id, biz.id, {
          accountNumber: '9988112233',
          bankCode: '033',
          bankName: 'UBA',
          pin: rawPin,
        });
      } catch (err: any) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('PAYOUT_CHANGE_LOCKED');
      }
    });

    test('blocks account modification when permission has expired (>24 hours)', async () => {
      const { user, biz } = await setupUserAndBiz('expiry-1');
      const expiredDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      await testDb.business.update({
        where: { id: biz.id },
        data: {
          payoutChangePermitted: true,
          payoutChangePermittedAt: expiredDate,
        },
      });

      try {
        await bankResolutionService.connectSettlementBank(user.id, biz.id, {
          accountNumber: '9988112233',
          bankCode: '033',
          bankName: 'UBA',
          pin: rawPin,
        });
        throw new Error('Should not succeed');
      } catch (err: any) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('PAYOUT_PERMISSION_EXPIRED');
      }
    });
  });

  describe('4. Concurrency & Locked Funds Invariants in Withdrawals', () => {
    test('double-withdrawal prevention: reserves funds in lockedBalance and blocks second withdrawal', async () => {
      const { user, biz } = await setupUserAndBiz('double-1');
      // Setup DVA sales so getPayoutPreview shows ₦50,000 available
      await testDb.salesTransaction.create({
        data: {
          businessId: biz.id,
          amount: 50000,
          source: 'bank_transfer',
          dvaOrigin: true,
          status: 'confirmed',
          referenceId: `REF-INFLOW-${Date.now()}`,
          isTaxable: true,
          transactionDate: new Date(),
        },
      });

      // Credit wallet
      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 50000,
        fee: 0,
        netAmount: 50000,
        reference: `WAL-CREDIT-${Date.now()}`,
        source: 'dva',
      });

      // 1st withdrawal: Request ₦40,000
      const res1 = await payoutService.withdrawBalance(user.id, biz.id, {
        amount: 40000,
        pin: rawPin,
      });

      expect(res1.status).toBe('pending');
      expect(res1.amount).toBe(40000);

      // Check DB: lockedBalance was incremented
      const walletAfter1 = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(walletAfter1!.lockedBalance)).toBeGreaterThan(0);

      // 2nd withdrawal: Attempt to withdraw ₦20,000 (only ~₦9,950 available)
      await expect(
        payoutService.withdrawBalance(user.id, biz.id, {
          amount: 20000,
          pin: rawPin,
        })
      ).rejects.toThrow(AppError);

      try {
        await payoutService.withdrawBalance(user.id, biz.id, {
          amount: 20000,
          pin: rawPin,
        });
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INSUFFICIENT_FUNDS');
      }
    });

    test('admin rejection releases locked funds back to available wallet balance', async () => {
      const { user, biz } = await setupUserAndBiz('reject-1');
      // Setup ₦60,000 available
      await testDb.salesTransaction.create({
        data: {
          businessId: biz.id,
          amount: 60000,
          source: 'bank_transfer',
          dvaOrigin: true,
          status: 'confirmed',
          referenceId: `REF-INFLOW-2-${Date.now()}`,
          isTaxable: true,
          transactionDate: new Date(),
        },
      });

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 60000,
        fee: 0,
        netAmount: 60000,
        reference: `WAL-CREDIT-2-${Date.now()}`,
        source: 'dva',
      });

      // Initiate withdrawal of ₦50,000
      const payoutReq = await payoutService.withdrawBalance(user.id, biz.id, {
        amount: 50000,
        pin: rawPin,
      });

      const walletBeforeReject = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(walletBeforeReject!.lockedBalance)).toBeGreaterThan(0);

      // Admin rejects
      const rejectRes = await payoutService.adminRejectWithdrawal(
        adminUser.id,
        payoutReq.id,
        'Flagged for KYC review'
      );

      expect(rejectRes.status).toBe('failed');

      // Assert lockedBalance was released back to 0
      const walletAfterReject = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(walletAfterReject!.lockedBalance)).toBe(0);
      expect(Number(walletAfterReject!.balance)).toBe(60000);
    });

    test('affordability check at approval time rejects payout if balance was depleted after submission', async () => {
      const { user, biz } = await setupUserAndBiz('afford-1');
      // Inflow of ₦30,000
      await testDb.salesTransaction.create({
        data: {
          businessId: biz.id,
          amount: 30000,
          source: 'bank_transfer',
          dvaOrigin: true,
          status: 'confirmed',
          referenceId: `REF-INFLOW-3-${Date.now()}`,
          isTaxable: true,
          transactionDate: new Date(),
        },
      });

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 30000,
        fee: 0,
        netAmount: 30000,
        reference: `WAL-CREDIT-3-${Date.now()}`,
        source: 'dva',
      });

      const payoutReq = await payoutService.withdrawBalance(user.id, biz.id, {
        amount: 25000,
        pin: rawPin,
      });

      // Simulate a concurrent withdrawal or debit that emptied the available balance
      await testDb.settlementPayout.create({
        data: {
          businessId: biz.id,
          amount: 30000,
          fee: 50,
          netAmount: 29950,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'TEST USER',
          transferReference: `PO-CONCURRENT-${Date.now()}`,
          status: 'completed',
        },
      });

      // Admin attempts to approve original payoutReq -> preview.availableForWithdrawal is now 0!
      await expect(
        payoutService.adminApproveWithdrawal(adminUser.id, payoutReq.id)
      ).rejects.toThrow(AppError);

      try {
        await payoutService.adminApproveWithdrawal(adminUser.id, payoutReq.id);
      } catch (err: any) {
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe('INSUFFICIENT_FUNDS_AT_APPROVAL');
      }
    });
  });

  describe('5. Fee Accounting & Elimination of Double Fee Bug', () => {
    test('instant auto-payout debits exact requested amount without double-fee penalty', async () => {
      const { user, biz } = await setupUserAndBiz('fee-1');
      await testDb.business.update({
        where: { id: biz.id },
        data: { autoPayoutEnabled: true },
      });

      // Credit wallet with ₦100,000
      await testDb.salesTransaction.create({
        data: {
          businessId: biz.id,
          amount: 100000,
          source: 'bank_transfer',
          dvaOrigin: true,
          status: 'confirmed',
          referenceId: `REF-FEE-TEST-${Date.now()}`,
          isTaxable: true,
          transactionDate: new Date(),
        },
      });

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 100000,
        fee: 0,
        netAmount: 100000,
        reference: `WAL-FEE-${Date.now()}`,
        source: 'dva',
      });

      // Mock Paystack provider for instant transfer success
      const mockProvider = {
        createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_QA_1' }),
        initiateTransfer: jest.fn<any>().mockResolvedValue({
          transferCode: 'TRF_QA_SUCCESS',
          status: 'success',
        }),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      // Withdraw ₦40,000 (WallX 1% fee capped at ₦300 -> netAmount is ₦39,700)
      const payoutRes = await payoutService.withdrawBalance(user.id, biz.id, {
        amount: 40000,
        pin: rawPin,
      });

      expect(payoutRes.status).toBe('completed');
      expect(payoutRes.amount).toBe(40000);
      expect(payoutRes.fee).toBe(300);
      expect(payoutRes.netAmount).toBe(39700);

      // Verify wallet state: MUST be exactly ₦60,000 (not ₦59,700 from double fee!)
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(wallet!.balance)).toBe(60000);
      expect(Number(wallet!.lockedBalance)).toBe(0);

      const available = await WalletService.getWalletBalance(user.id);
      expect(available.availableBalance).toBe(60000);

      // Check transaction ledger entry
      const ledgerTx = await testDb.walletTransaction.findFirst({
        where: { linkedPayoutId: payoutRes.id },
      });
      expect(ledgerTx).toBeDefined();
      expect(Number(ledgerTx!.amount)).toBe(40000);
      expect(Number(ledgerTx!.netAmount)).toBe(-40000);
    });
  });

  describe('6. Failure Rollback & Zero Stuck Locked-Funds Invariants', () => {
    test('instant auto-payout transfer failure releases locked funds and restores available balance', async () => {
      const { user, biz } = await setupUserAndBiz('fail-auto-1');
      await testDb.business.update({
        where: { id: biz.id },
        data: { autoPayoutEnabled: true },
      });

      await testDb.salesTransaction.create({
        data: {
          businessId: biz.id,
          amount: 80000,
          source: 'bank_transfer',
          dvaOrigin: true,
          status: 'confirmed',
          referenceId: `REF-FAIL-AUTO-${Date.now()}`,
          isTaxable: true,
          transactionDate: new Date(),
        },
      });

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 80000,
        fee: 0,
        netAmount: 80000,
        reference: `WAL-FAIL-AUTO-${Date.now()}`,
        source: 'dva',
      });

      // Mock provider to throw network error on initiateTransfer
      const mockProvider = {
        createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_FAIL_1' }),
        initiateTransfer: jest.fn<any>().mockRejectedValue(new Error('Paystack connection timeout')),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      await expect(
        payoutService.withdrawBalance(user.id, biz.id, {
          amount: 50000,
          pin: rawPin,
        })
      ).rejects.toThrow('Paystack connection timeout');

      // Verify DB payout status is failed
      const payout = await testDb.settlementPayout.findFirst({
        where: { businessId: biz.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(payout!.status).toBe('failed');

      // Verify wallet state: lockedBalance MUST be 0, full ₦80,000 available
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(wallet!.lockedBalance)).toBe(0);
      expect(Number(wallet!.balance)).toBe(80000);

      const bal = await WalletService.getWalletBalance(user.id);
      expect(bal.availableBalance).toBe(80000);
    });

    test('admin approval transfer failure releases locked funds and restores available balance', async () => {
      const { user, biz } = await setupUserAndBiz('fail-approve-1');

      await testDb.salesTransaction.create({
        data: {
          businessId: biz.id,
          amount: 70000,
          source: 'bank_transfer',
          dvaOrigin: true,
          status: 'confirmed',
          referenceId: `REF-FAIL-APP-${Date.now()}`,
          isTaxable: true,
          transactionDate: new Date(),
        },
      });

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 70000,
        fee: 0,
        netAmount: 70000,
        reference: `WAL-FAIL-APP-${Date.now()}`,
        source: 'dva',
      });

      // Request withdrawal (manual approval mode)
      const payoutReq = await payoutService.withdrawBalance(user.id, biz.id, {
        amount: 45000,
        pin: rawPin,
      });

      const walletPending = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(walletPending!.lockedBalance)).toBe(45000);

      // Mock provider to throw on transfer initiation during approval
      const mockProvider = {
        createTransferRecipient: jest.fn<any>().mockResolvedValue({ recipientCode: 'RCP_FAIL_2' }),
        initiateTransfer: jest.fn<any>().mockRejectedValue(new Error('NIBSS switch down')),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      await expect(
        payoutService.adminApproveWithdrawal(adminUser.id, payoutReq.id)
      ).rejects.toThrow('NIBSS switch down');

      // Verify DB payout status is failed
      const payout = await testDb.settlementPayout.findUnique({
        where: { id: payoutReq.id },
      });
      expect(payout!.status).toBe('failed');

      // Verify wallet lockedBalance is released back to 0
      const walletAfter = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(walletAfter!.lockedBalance)).toBe(0);
      expect(Number(walletAfter!.balance)).toBe(70000);

      const bal = await WalletService.getWalletBalance(user.id);
      expect(bal.availableBalance).toBe(70000);
    });
  });

  describe('7. Admin Requery State Convergence & Event Emission', () => {
    test('requery success settles debit, zeroes lockedBalance, and emits payout.completed', async () => {
      const { user, biz } = await setupUserAndBiz('requery-succ-1');

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 50000,
        fee: 0,
        netAmount: 50000,
        reference: `WAL-REQ-S-${Date.now()}`,
        source: 'dva',
      });

      const ref = `PO-REQ-S-${Date.now()}`;
      const payout = await testDb.settlementPayout.create({
        data: {
          businessId: biz.id,
          amount: 30000,
          fee: 300,
          netAmount: 29700,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'TEST USER',
          transferReference: ref,
          status: 'processing',
        },
      });

      await WalletService.reserveFunds({
        userId: user.id,
        amount: 30000,
        fee: 0,
        reference: ref,
        linkedPayoutId: payout.id,
      });

      const mockProvider = {
        verifyTransfer: jest.fn<any>().mockResolvedValue({
          status: 'success',
          gatewayResponse: 'Transaction Successful',
        }),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      const events: any[] = [];
      eventBus.on('payout.completed', (ev) => events.push(ev));

      const res = await payoutService.adminRequeryWithdrawal(adminUser.id, payout.id);
      expect(res.status).toBe('completed');

      const updatedPayout = await testDb.settlementPayout.findUnique({
        where: { id: payout.id },
      });
      expect(updatedPayout!.status).toBe('completed');

      // Assert wallet debit settled: balance is ₦20,000, locked is 0
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(wallet!.balance)).toBe(20000);
      expect(Number(wallet!.lockedBalance)).toBe(0);

      // Assert event emitted
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        userId: user.id,
        payoutId: payout.id,
        amount: 30000,
        reference: ref,
      });
    });

    test('requery failure releases lockedBalance back to available balance', async () => {
      const { user, biz } = await setupUserAndBiz('requery-fail-1');

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 50000,
        fee: 0,
        netAmount: 50000,
        reference: `WAL-REQ-F-${Date.now()}`,
        source: 'dva',
      });

      const ref = `PO-REQ-F-${Date.now()}`;
      const payout = await testDb.settlementPayout.create({
        data: {
          businessId: biz.id,
          amount: 25000,
          fee: 250,
          netAmount: 24750,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'TEST USER',
          transferReference: ref,
          status: 'processing',
        },
      });

      await WalletService.reserveFunds({
        userId: user.id,
        amount: 25000,
        fee: 0,
        reference: ref,
        linkedPayoutId: payout.id,
      });

      const mockProvider = {
        verifyTransfer: jest.fn<any>().mockResolvedValue({
          status: 'failed',
          gatewayResponse: 'Account number does not exist',
        }),
      };
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

      const res = await payoutService.adminRequeryWithdrawal(adminUser.id, payout.id);
      expect(res.status).toBe('failed');

      // Assert locked funds released: balance stays ₦50,000, locked is 0
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(wallet!.balance)).toBe(50000);
      expect(Number(wallet!.lockedBalance)).toBe(0);
    });
  });

  describe('8. Webhook Payout Event Bus & Ledger Settlement', () => {
    test('transfer.success webhook settles payout debit and emits payout.completed', async () => {
      const { user, biz } = await setupUserAndBiz('wh-succ-1');

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 100000,
        fee: 0,
        netAmount: 100000,
        reference: `WAL-WH-S-${Date.now()}`,
        source: 'dva',
      });

      const ref = `PO-WH-S-${Date.now()}`;
      const payout = await testDb.settlementPayout.create({
        data: {
          businessId: biz.id,
          amount: 40000,
          fee: 300,
          netAmount: 39700,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'TEST USER',
          transferReference: ref,
          status: 'processing',
        },
      });

      await WalletService.reserveFunds({
        userId: user.id,
        amount: 40000,
        fee: 0,
        reference: ref,
        linkedPayoutId: payout.id,
      });

      const events: any[] = [];
      eventBus.on('payout.completed', (ev) => events.push(ev));

      const payload = {
        event: 'transfer.success',
        data: {
          reference: ref,
          transfer_code: 'TRF_WH_123',
          amount: 3970000, // in kobo
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha512', config.paystack.webhookSecret)
        .update(rawBody)
        .digest('hex');

      await processWebhook(signature, rawBody);

      const updatedPayout = await testDb.settlementPayout.findUnique({
        where: { id: payout.id },
      });
      expect(updatedPayout!.status).toBe('completed');

      // Assert wallet balance: ₦60,000 (not ₦59,700), lockedBalance: 0
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(wallet!.balance)).toBe(60000);
      expect(Number(wallet!.lockedBalance)).toBe(0);

      // Assert event was emitted
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        userId: user.id,
        payoutId: payout.id,
        amount: 40000,
        reference: ref,
      });
    });

    test('transfer.failed webhook releases locked funds', async () => {
      const { user, biz } = await setupUserAndBiz('wh-fail-1');

      await WalletService.creditWallet({
        userId: user.id,
        businessId: biz.id,
        amount: 100000,
        fee: 0,
        netAmount: 100000,
        reference: `WAL-WH-F-${Date.now()}`,
        source: 'dva',
      });

      const ref = `PO-WH-F-${Date.now()}`;
      const payout = await testDb.settlementPayout.create({
        data: {
          businessId: biz.id,
          amount: 35000,
          fee: 300,
          netAmount: 34700,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'TEST USER',
          transferReference: ref,
          status: 'processing',
        },
      });

      await WalletService.reserveFunds({
        userId: user.id,
        amount: 35000,
        fee: 0,
        reference: ref,
        linkedPayoutId: payout.id,
      });

      const payload = {
        event: 'transfer.failed',
        data: {
          reference: ref,
          transfer_code: 'TRF_WH_FAIL',
          reason: 'Beneficiary bank unavailable',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha512', config.paystack.webhookSecret)
        .update(rawBody)
        .digest('hex');

      await processWebhook(signature, rawBody);

      const updatedPayout = await testDb.settlementPayout.findUnique({
        where: { id: payout.id },
      });
      expect(updatedPayout!.status).toBe('failed');

      // Assert locked funds released
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: user.id },
      });
      expect(Number(wallet!.balance)).toBe(100000);
      expect(Number(wallet!.lockedBalance)).toBe(0);
    });
  });
});
