import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import { prisma } from '../../src/lib/prisma';
import { WalletService } from '../../src/services/wallet.service';
import * as dvaService from '../../src/services/dva.service';
import { runWalletReconciliationSweep } from '../../src/jobs/wallet-reconciliation.cron';
import { Prisma, WalletTxType } from '@prisma/client';
import { AppError } from '../../src/middleware/errorHandler';
import { toNumber } from '../../src/shared/helpers/number';

/**
 * Phase 2 Live Database Central Wallet & DVA Optimization Verification Suite
 *
 * This test suite executes against the real PostgreSQL database (NO MOCKS).
 * It empirically proves:
 * 1. O(1) wallet retrieval and auto-initialization.
 * 2. Parallel concurrent atomic credits with zero balance drift.
 * 3. Idempotency de-duplication on reference, idempotencyKey, and linkedSaleId.
 * 4. Fund locking (reserveFunds) and insufficiency guards.
 * 5. Payout debit settlement and locked balance decrement.
 * 6. Fund release on payout failure or rejection.
 * 7. dvaOrigin: true filtering in DVA services (leveraging composite B-tree index).
 * 8. Nightly wallet reconciliation cron sweep and invariant validation.
 */
describe('Phase 2 Live Database Central Wallet & DVA Verification', () => {
  jest.setTimeout(30000);
  let user1: any;
  let user2: any;
  let business1: any;

  beforeAll(async () => {
    try {
      await prisma.$executeRaw`SELECT pg_advisory_unlock_all()`;
      await testDb.$executeRaw`SELECT pg_advisory_unlock_all()`;
    } catch (_) {}
    await clearDatabase();

    user1 = await createTestUser('wallet-live-user1@example.com');
    user2 = await createTestUser('wallet-live-user2@example.com');
    business1 = await createTestBusiness(user1.id, 'Wallet Live Enterprise');
  }, 30000);

  afterAll(async () => {
    try {
      await prisma.$executeRaw`SELECT pg_advisory_unlock_all()`;
      await testDb.$executeRaw`SELECT pg_advisory_unlock_all()`;
    } catch (_) {}
    await clearDatabase();
    await prisma.$disconnect();
    await testDb.$disconnect();
  }, 30000);

  // ─── 1. Wallet Initialization & O(1) Balance Read ───────────

  describe('1. Wallet Initialization & O(1) Balance Read', () => {
    test('creates a fresh zero-balance wallet for a user', async () => {
      const wallet = await WalletService.getOrCreateWallet(user1.id);

      expect(wallet).toBeDefined();
      expect(wallet.userId).toBe(user1.id);
      expect(toNumber(wallet.balance)).toBe(0);
      expect(toNumber(wallet.lockedBalance)).toBe(0);
      expect(wallet.currency).toBe('NGN');
      expect(wallet.version).toBe(0);
    });

    test('getOrCreateWallet returns existing record idempotently without duplicate creation', async () => {
      const walletFirst = await WalletService.getOrCreateWallet(user1.id);
      const walletSecond = await WalletService.getOrCreateWallet(user1.id);

      expect(walletSecond.id).toBe(walletFirst.id);
      expect(walletSecond.version).toBe(walletFirst.version);
    });

    test('getWalletBalance returns correct initial DTO', async () => {
      const balanceDto = await WalletService.getWalletBalance(user1.id);

      expect(balanceDto.balance).toBe(0);
      expect(balanceDto.lockedBalance).toBe(0);
      expect(balanceDto.availableBalance).toBe(0);
      expect(balanceDto.version).toBe(0);
      expect(balanceDto.currency).toBe('NGN');
    });
  });

  // ─── 2. Parallel Concurrent Atomic Credits ──────────────────

  describe('2. Parallel Concurrent Atomic Credits (Zero Drift Under Load)', () => {
    test('executes 10 concurrent credits of ₦10,000 each with zero balance drift', async () => {
      const creditOperations = Array.from({ length: 10 }, (_, i) =>
        WalletService.creditWallet({
          userId: user1.id,
          businessId: business1.id,
          amount: 10000,
          fee: 0,
          reference: `CONCURRENT_CREDIT_${Date.now()}_${i}`,
          source: 'dva_transfer',
          description: `Concurrent transfer batch #${i + 1}`,
          idempotencyKey: `IDEM_CONCURRENT_${Date.now()}_${i}`,
        })
      );

      const results = await Promise.all(creditOperations);

      // Verify all 10 operations succeeded without duplication
      for (const res of results) {
        expect(res.alreadyProcessed).toBe(false);
      }

      // Check live database state
      const finalWallet = await testDb.walletBalance.findUnique({
        where: { userId: user1.id },
      });

      expect(finalWallet).not.toBeNull();
      // Total balance must be exactly ₦100,000.00
      expect(toNumber(finalWallet!.balance)).toBe(100000);
      // Version must be exactly 10 increments
      expect(finalWallet!.version).toBe(10);

      // Verify exactly 10 ledger transactions exist
      const txCount = await testDb.walletTransaction.count({
        where: { userId: user1.id },
      });
      expect(txCount).toBe(10);
    }, 60000);
  });

  // ─── 3. Idempotency De-duplication ──────────────────────────

  describe('3. Idempotency De-duplication Guards', () => {
    test('re-submitting with identical reference returns existing tx without changing balance', async () => {
      const ref = `UNIQUE_DEDUP_REF_${Date.now()}`;

      // First credit: ₦5,000
      const first = await WalletService.creditWallet({
        userId: user1.id,
        amount: 5000,
        reference: ref,
        source: 'manual',
      });
      expect(first.alreadyProcessed).toBe(false);

      const balAfterFirst = await WalletService.getWalletBalance(user1.id);
      expect(balAfterFirst.balance).toBe(105000);

      // Second credit with identical reference: should be de-duplicated
      const second = await WalletService.creditWallet({
        userId: user1.id,
        amount: 5000,
        reference: ref,
        source: 'manual',
      });
      expect(second.alreadyProcessed).toBe(true);
      expect(second.transaction.id).toBe(first.transaction.id);

      const balAfterSecond = await WalletService.getWalletBalance(user1.id);
      expect(balAfterSecond.balance).toBe(105000); // Unchanged!
    });

    test('re-submitting with identical idempotencyKey returns existing tx without changing balance', async () => {
      const idemKey = `UNIQUE_IDEM_KEY_${Date.now()}`;

      // First credit: ₦2,000
      const first = await WalletService.creditWallet({
        userId: user1.id,
        amount: 2000,
        reference: `REF_IDEM_1_${Date.now()}`,
        source: 'manual',
        idempotencyKey: idemKey,
      });
      expect(first.alreadyProcessed).toBe(false);

      // Second credit with same idempotencyKey but different reference: should be de-duplicated
      const second = await WalletService.creditWallet({
        userId: user1.id,
        amount: 2000,
        reference: `REF_IDEM_2_${Date.now()}`,
        source: 'manual',
        idempotencyKey: idemKey,
      });
      expect(second.alreadyProcessed).toBe(true);
      expect(second.transaction.id).toBe(first.transaction.id);

      const bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.balance).toBe(107000);
    });

    test('re-submitting with identical linkedSaleId returns existing tx', async () => {
      // Create a dummy sale
      const sale = await testDb.salesTransaction.create({
        data: {
          businessId: business1.id,
          amount: new Prisma.Decimal(3000),
          transactionDate: new Date(),
          source: 'bank_transfer',
          status: 'confirmed',
          dvaOrigin: true,
        },
      });

      const first = await WalletService.creditWallet({
        userId: user1.id,
        amount: 3000,
        reference: `SALE_REF_1_${Date.now()}`,
        source: 'dva_transfer',
        linkedSaleId: sale.id,
      });
      expect(first.alreadyProcessed).toBe(false);

      const second = await WalletService.creditWallet({
        userId: user1.id,
        amount: 3000,
        reference: `SALE_REF_2_${Date.now()}`,
        source: 'dva_transfer',
        linkedSaleId: sale.id,
      });
      expect(second.alreadyProcessed).toBe(true);
      expect(second.transaction.id).toBe(first.transaction.id);

      const bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.balance).toBe(110000);
    });
  });

  // ─── 4. Fund Reservation & Locked Balance ────────────────────

  describe('4. Fund Reservation & Sufficiency Enforcement', () => {
    test('rejects fund reservation when requested amount exceeds available balance', async () => {
      // Current balance = 110,000. Try to reserve 150,000
      await expect(
        WalletService.reserveFunds({
          userId: user1.id,
          amount: 150000,
          fee: 50,
          reference: `FAIL_RESERVE_${Date.now()}`,
        })
      ).rejects.toThrow(AppError);

      const bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.lockedBalance).toBe(0);
      expect(bal.availableBalance).toBe(110000);
    });

    test('reserves funds successfully and adjusts locked & available balances', async () => {
      // Reserve ₦40,000 + ₦50 fee = ₦40,050
      const reservation = await WalletService.reserveFunds({
        userId: user1.id,
        amount: 40000,
        fee: 50,
        reference: `SUCCESS_RESERVE_${Date.now()}`,
      });

      expect(reservation.success).toBe(true);
      expect(reservation.lockedAmount).toBe(40050);

      const bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.balance).toBe(110000);
      expect(bal.lockedBalance).toBe(40050);
      expect(bal.availableBalance).toBe(69950);
    });
  });

  // ─── 5. Settlement Payout Debit ─────────────────────────────

  describe('5. Settlement Payout Debit Settlement', () => {
    test('settles payout debit: decrements both total balance and locked balance', async () => {
      const payoutRef = `PAYOUT_SETTLE_${Date.now()}`;

      const settlement = await WalletService.settlePayoutDebit({
        userId: user1.id,
        businessId: business1.id,
        amount: 40000,
        fee: 50,
        reference: payoutRef,
        description: 'Bank transfer to GTB',
      });

      expect(settlement.transaction.type).toBe(WalletTxType.payout);
      expect(toNumber(settlement.transaction.amount)).toBe(40000);
      expect(toNumber(settlement.transaction.fee)).toBe(50);
      expect(toNumber(settlement.transaction.netAmount)).toBe(-40050);

      const bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.balance).toBe(69950);
      expect(bal.lockedBalance).toBe(0);
      expect(bal.availableBalance).toBe(69950);
    });
  });

  // ─── 6. Locked Fund Release ─────────────────────────────────

  describe('6. Locked Fund Release on Failure/Rejection', () => {
    test('reserves funds and then releases them cleanly back to available balance', async () => {
      // Reserve ₦20,000 + ₦50 fee = ₦20,050
      await WalletService.reserveFunds({
        userId: user1.id,
        amount: 20000,
        fee: 50,
        reference: `CANCELLED_RESERVE_${Date.now()}`,
      });

      let bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.lockedBalance).toBe(20050);
      expect(bal.availableBalance).toBe(49900);

      // Now release the locked funds
      const release = await WalletService.releaseLockedFunds({
        userId: user1.id,
        amount: 20000,
        fee: 50,
      });

      expect(release.success).toBe(true);
      expect(release.releasedAmount).toBe(20050);

      bal = await WalletService.getWalletBalance(user1.id);
      expect(bal.balance).toBe(69950);
      expect(bal.lockedBalance).toBe(0);
      expect(bal.availableBalance).toBe(69950);
    });
  });

  // ─── 7. DVA Origin Optimization Verification ────────────────

  describe('7. DVA Origin Filter & Query Optimization', () => {
    test('getDVABalance filters strictly on dvaOrigin: true and ignores non-DVA sales', async () => {
      // Create user2 and business2
      const biz2 = await createTestBusiness(user2.id, 'DVA Test Business');
      // Set virtualAccountNumber on biz2
      await testDb.business.update({
        where: { id: biz2.id },
        data: { virtualAccountNumber: '0987654321' },
      });

      // 1. DVA-originated sale
      await testDb.salesTransaction.create({
        data: {
          businessId: biz2.id,
          amount: new Prisma.Decimal(50000),
          source: 'bank_transfer',
          status: 'confirmed',
          dvaOrigin: true, // DVA
          transactionDate: new Date(),
        },
      });

      // 2. Manual bank transfer sale (NOT DVA)
      await testDb.salesTransaction.create({
        data: {
          businessId: biz2.id,
          amount: new Prisma.Decimal(25000),
          source: 'bank_transfer',
          status: 'confirmed',
          dvaOrigin: false, // Manual entry
          transactionDate: new Date(),
        },
      });

      const dvaBalance = await dvaService.getDVABalance(user2.id, biz2.id);

      // Should ONLY include the ₦50,000 DVA sale, NOT the ₦25,000 manual sale
      expect(toNumber(dvaBalance.completed.total)).toBe(50000);
      expect(dvaBalance.completed.count).toBe(1);
    });
  });

  // ─── 8. Nightly Wallet Reconciliation Invariant Sweep ───────

  describe('8. Nightly Wallet Reconciliation Invariant Sweep', () => {
    test('reconciliation sweep verifies ledger sum matches wallet balance (Invariant 1)', async () => {
      const summary = await runWalletReconciliationSweep({ bypassLock: true });

      expect(summary.usersAudited).toBeGreaterThanOrEqual(1);
      expect(summary.ledgerMismatchCount).toBe(0);
    }, 60000);

    test('reconciliation sweep detects balance drift if wallet is modified outside ledger', async () => {
      // Tamper: arbitrarily inject ₦1,000 into walletBalance without a ledger transaction
      await testDb.walletBalance.update({
        where: { userId: user1.id },
        data: { balance: { increment: 1000 } },
      });

      const summary = await runWalletReconciliationSweep({ bypassLock: true });

      expect(summary.ledgerMismatchCount).toBeGreaterThanOrEqual(1);

      // Restore wallet back to match ledger
      await testDb.walletBalance.update({
        where: { userId: user1.id },
        data: { balance: { decrement: 1000 } },
      });

      // Sweep again should be completely clean
      const cleanSummary = await runWalletReconciliationSweep({ bypassLock: true });
      expect(cleanSummary.ledgerMismatchCount).toBe(0);
    }, 60000);
  });
});
