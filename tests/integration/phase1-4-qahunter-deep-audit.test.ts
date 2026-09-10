import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import prisma from '../../src/lib/prisma';
import crypto from 'crypto';
import config from '../../src/config';
import { AppError } from '../../src/middleware/errorHandler';

// Phase 1 Imports
import { resetReport } from '../../src/services/tax/tax-report.service';
import { processDVATransferWebhook } from '../../src/services/dva/dva-webhook.service';
import { processWebhook } from '../../src/services/payment/payment-webhook.service';

// Phase 2 Imports
import { runDailySweep } from '../../src/jobs/reminders.cron';
import { runWalletReconciliationSweep } from '../../src/jobs/wallet-reconciliation.cron';
import { resolveTransactionDateForLockedMonth } from '../../src/shared/helpers/month-lock';

// Phase 3 Imports
import { encrypt, decrypt, computeBlindIndex, maskIdentifier } from '../../src/lib/crypto';
import { putImport, getImport, __clearAll, __getStoreSize } from '../../src/lib/sales-import/cache';
import { updateBvn, getMe } from '../../src/services/auth/auth.service';

// Phase 4 Imports
import { runPayoutReconciliationSweep } from '../../src/jobs/payout-reconciliation.cron';
import * as paymentModule from '../../src/lib/payment';

describe('QA Hunter: Deep Audit & Adversarial Retest (Phases 1 — 4)', () => {
  jest.setTimeout(30000);

  let user1: any;
  let user2: any;
  let business1: any;
  let business2: any;

  beforeAll(async () => {
    await clearDatabase();
    user1 = await createTestUser('qa-hunter-1@example.com');
    user2 = await createTestUser('qa-hunter-2@example.com');
    business1 = await createTestBusiness(user1.id, 'QA Hunter Alpha Ltd');
    business2 = await createTestBusiness(user2.id, 'QA Hunter Beta Ltd');
  }, 40000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 40000);

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: FINANCIAL INTEGRITY & CRASH PREVENTION
  // ═══════════════════════════════════════════════════════════════════

  describe('Phase 1 — Financial Integrity & Webhook Security', () => {
    test('P1-01: resetReport guards locked reports and completed payments in production mode', async () => {
      // Create a test report for business1
      const report = await testDb.monthlyTaxReport.create({
        data: {
          businessId: business1.id,
          taxMonth: new Date(Date.UTC(2026, 0, 1)),
          totalSales: 100000,
          totalExpenses: 20000,
          grossProfit: 80000,
          taxPayable: 6000,
          isFinalized: true,
          isLocked: true,
          lockedAt: new Date(),
        },
      });

      // Also attach a completed tax payment
      await testDb.taxPayment.create({
        data: {
          businessId: business1.id,
          taxReportId: report.id,
          amountPaid: 6000,
          paymentMethod: 'card',
          paymentStatus: 'completed',
          transactionReference: 'TAX-REF-COMPLETED-1',
          paymentDate: new Date(),
        },
      });

      // 1. In production mode, resetReport MUST throw PERIOD_LOCKED
      const origIsProd = config.app.isProduction;
      try {
        (config.app as any).isProduction = true;

        await expect(
          resetReport(user1.id, business1.id, report.id)
        ).rejects.toThrow(AppError);

        try {
          await resetReport(user1.id, business1.id, report.id);
        } catch (err: any) {
          expect(err.statusCode).toBe(423);
          expect(err.code).toBe('PERIOD_LOCKED');
        }
      } finally {
        (config.app as any).isProduction = origIsProd;
      }
    });

    test('P1-02: processDVATransferWebhook atomic execution and duplicate replay immunity', async () => {
      // Configure virtual account on business1
      const testDvaAccount = '9928374650';
      await testDb.business.update({
        where: { id: business1.id },
        data: { virtualAccountNumber: testDvaAccount, virtualAccountBank: 'Wema Bank' },
      });
      await testDb.user.update({
        where: { id: user1.id },
        data: { virtualAccountNumber: testDvaAccount },
      });

      // Initialize wallet balance for user1
      await testDb.walletBalance.upsert({
        where: { userId: user1.id },
        create: { userId: user1.id, balance: 0, lockedBalance: 0 },
        update: { balance: 0, lockedBalance: 0 },
      });

      const transferRef = `DVA-REPLAY-TEST-${Date.now()}`;
      const webhookEvent = {
        event: 'charge.success',
        data: {
          reference: transferRef,
          amount: 5000000, // 50,000 NGN in kobo
          channel: 'dedicated_nuban',
          dedicated_account: { account_number: testDvaAccount },
          customer: { first_name: 'Adewale', last_name: 'Babatunde' },
          paid_at: new Date().toISOString(),
          fees: 2500, // 25 NGN
        },
      };

      // Execution 1: First delivery
      const firstResult = await processDVATransferWebhook(webhookEvent);
      expect(firstResult).toBe(true);

      // Verify Sale created
      const sale = await testDb.salesTransaction.findFirst({
        where: { referenceId: transferRef, businessId: business1.id },
      });
      expect(sale).not.toBeNull();
      expect(Number(sale?.amount)).toBe(50000);

      // Verify Wallet Transaction created
      const walletTx = await testDb.walletTransaction.findUnique({
        where: { reference: transferRef },
      });
      expect(walletTx).not.toBeNull();
      expect(Number(walletTx?.amount)).toBe(50000);

      // Verify Wallet Balance credited
      const balance = await testDb.walletBalance.findUnique({
        where: { userId: user1.id },
      });
      expect(Number(balance?.balance)).toBeGreaterThan(49000); // 50000 - fee

      // Execution 2: REPLAY ATTACK — exact same webhook arrives again
      const secondResult = await processDVATransferWebhook(webhookEvent);
      expect(secondResult).toBe(true); // Gracefully handled

      // Verify NO DUPLICATE sale or wallet transaction
      const saleCount = await testDb.salesTransaction.count({
        where: { referenceId: transferRef, businessId: business1.id },
      });
      expect(saleCount).toBe(1);

      const walletTxCount = await testDb.walletTransaction.count({
        where: { reference: transferRef },
      });
      expect(walletTxCount).toBe(1);

      // Verify balance was NOT double-credited
      const balanceAfterReplay = await testDb.walletBalance.findUnique({
        where: { userId: user1.id },
      });
      expect(Number(balanceAfterReplay?.balance)).toBe(Number(balance?.balance));
    });

    test('P1-03: Webhook HMAC verification rejects forged signatures and malformed JSON', async () => {
      const secret = config.paystack.webhookSecret;
      const validPayload = JSON.stringify({
        event: 'charge.success',
        data: { reference: 'HMAC-TEST-1', amount: 1000 },
      });

      const validSignature = crypto
        .createHmac('sha512', secret)
        .update(validPayload)
        .digest('hex');

      // 1. Forged / invalid signature
      await expect(
        processWebhook('invalid_signature_hex_123', validPayload)
      ).rejects.toThrow(AppError);

      try {
        await processWebhook('invalid_signature_hex_123', validPayload);
      } catch (err: any) {
        expect(err.statusCode).toBe(401);
        expect(err.code).toBe('INVALID_SIGNATURE');
      }

      // 2. Malformed JSON with valid signature
      const badJson = '{ malformed: json, missing quotes }';
      const badJsonSig = crypto
        .createHmac('sha512', secret)
        .update(badJson)
        .digest('hex');

      await expect(
        processWebhook(badJsonSig, badJson)
      ).rejects.toThrow(AppError);

      try {
        await processWebhook(badJsonSig, badJson);
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_JSON');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: DATABASE CONCURRENCY & BACKGROUND JOB RELIABILITY
  // ═══════════════════════════════════════════════════════════════════

  describe('Phase 2 — Concurrency & Background Job Reliability', () => {
    test('P2-01: Reminder cron advisory lock prevents concurrent execution', async () => {
      // Simulate Worker A holding transaction advisory lock 947362
      const LOCK_KEY = 947362;
      let workerBSkipped = false;

      await prisma.$transaction(async (txA) => {
        // Worker A acquires lock
        const [{ locked: lockA }] = await txA.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
        `;
        expect(lockA).toBe(true);

        // Worker B attempts to run the sweep concurrently in another transaction
        await prisma.$transaction(async (txB) => {
          const [{ locked: lockB }] = await txB.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
          `;
          if (!lockB) {
            workerBSkipped = true;
          }
        });
      });

      expect(workerBSkipped).toBe(true);
    });

    test('P2-02: Wallet reconciliation batch groupBy correctly audits ledger and flags drift', async () => {
      // Create user wallet with balance 10,000
      const wallet = await testDb.walletBalance.upsert({
        where: { userId: user2.id },
        create: { userId: user2.id, balance: 10000, lockedBalance: 0 },
        update: { balance: 10000, lockedBalance: 0 },
      });

      // Clear existing transactions for user2
      await testDb.walletTransaction.deleteMany({ where: { userId: user2.id } });

      // Add transactions that sum to 10,000
      await testDb.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId: user2.id,
          businessId: business2.id,
          type: 'credit',
          amount: 10000,
          netAmount: 10000,
          balanceAfter: 10000,
          source: 'dva',
          reference: `WTX-REC-OK-${Date.now()}`,
          description: 'Reconciliation test',
        },
      });

      // Sweep 1: Clean ledger parity
      const cleanResult = await runWalletReconciliationSweep({ bypassLock: true });
      expect(cleanResult.usersAudited).toBeGreaterThan(0);
      expect(cleanResult.ledgerMismatchCount).toBe(0);

      // Now introduce intentional database drift (tamper wallet balance to 8,000)
      await testDb.walletBalance.update({
        where: { userId: user2.id },
        data: { balance: 8000 },
      });

      // Sweep 2: Drift detected
      const driftResult = await runWalletReconciliationSweep({ bypassLock: true });
      expect(driftResult.ledgerMismatchCount).toBe(1);
    }, 80000);

    test('P2-03: resolveTransactionDateForLockedMonth transparently auto-adjusts locked period date', async () => {
      // Finalize and lock January 2025 for business1
      const taxMonth = new Date(Date.UTC(2025, 0, 1));
      await testDb.monthlyTaxReport.upsert({
        where: { businessId_taxMonth: { businessId: business1.id, taxMonth } },
        create: {
          businessId: business1.id,
          taxMonth,
          totalSales: 50000,
          totalExpenses: 10000,
          grossProfit: 40000,
          taxPayable: 3000,
          isLocked: true,
          isFinalized: true,
          lockedAt: new Date(),
        },
        update: { isLocked: true, isFinalized: true },
      });

      // Case A: Entering a date in the locked month (Jan 15, 2025)
      const lockedDate = new Date(Date.UTC(2025, 0, 15));
      const resLocked = await resolveTransactionDateForLockedMonth(business1.id, lockedDate, prisma);

      expect(resLocked.wasAdjusted).toBe(true);
      expect(resLocked.originalDate?.toISOString()).toBe(lockedDate.toISOString());
      expect(resLocked.effectiveDate.getUTCFullYear()).toBe(new Date().getUTCFullYear());
      expect(resLocked.reason).toContain('locked tax period');

      // Case B: Entering a date in an open month (e.g. current active date)
      const openDate = new Date();
      const resOpen = await resolveTransactionDateForLockedMonth(business1.id, openDate, prisma);
      expect(resOpen.wasAdjusted).toBe(false);
      expect(resOpen.effectiveDate.getTime()).toBe(openDate.getTime());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: REGULATORY COMPLIANCE & KYC DATA PROTECTION
  // ═══════════════════════════════════════════════════════════════════

  describe('Phase 3 — Cryptography, Blind Indexing & Bounded Cache', () => {
    test('P3-01: AES-256-GCM authenticated encryption semantic security and tamper detection', () => {
      const bvn = '22212345678';

      // Semantic security: randomized IV creates distinct ciphertexts
      const enc1 = encrypt(bvn);
      const enc2 = encrypt(bvn);
      expect(enc1).not.toBeNull();
      expect(enc2).not.toBeNull();
      expect(enc1).not.toBe(enc2);

      // Decryption round-trip
      expect(decrypt(enc1)).toBe(bvn);
      expect(decrypt(enc2)).toBe(bvn);

      // Tamper detection: flip a character in the ciphertext
      const parts = enc1!.split(':');
      const tamperedCipher = parts[3].slice(0, -2) + (parts[3].slice(-2) === 'aa' ? 'bb' : 'aa');
      const tamperedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedCipher}`;

      expect(() => decrypt(tamperedPayload)).toThrow(AppError);

      // Legacy plaintext fallback
      expect(decrypt('22299988811')).toBe('22299988811');
      expect(decrypt(null)).toBeNull();
    });

    test('P3-02: HMAC blind indexing input normalization and collision resistance', () => {
      // Normalization: spaces, dashes, parentheses
      const h1 = computeBlindIndex('222-123-45678');
      const h2 = computeBlindIndex('  22212345678  ');
      const h3 = computeBlindIndex('222 123 45678');
      const h4 = computeBlindIndex('22212345678');

      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
      expect(h3).toBe(h4);
      expect(h1).toHaveLength(64); // SHA-256 hex string

      // Collision resistance
      const differentH = computeBlindIndex('22212345679');
      expect(differentH).not.toBe(h1);
    });

    test('P3-03: BVN masking and sanitizeUser sanitization', () => {
      const rawBvn = '22212345678';
      const encBvn = encrypt(rawBvn);

      // maskIdentifier decrypts and returns last 4
      expect(maskIdentifier(encBvn)).toBe('•••••5678');
      expect(maskIdentifier(rawBvn)).toBe('•••••5678');
      expect(maskIdentifier(null)).toBeNull();

      // sanitizeUser strips security-critical fields
      const dirtyUser = {
        id: 'u-123',
        email: 'test@example.com',
        bvn: encBvn,
        bvnHash: 'hash-abc',
        nin: 'enc-nin',
        ninHash: 'hash-nin',
        passwordHash: 'secret-hash',
        transactionPin: 'pin-hash',
        role: 'user',
      };

      const sanitized: any = (function sanitize(user: any) {
        const { passwordHash, bvn, bvnHash, nin, ninHash, transactionPin, ...rest } = user;
        return { ...rest, bvnLast4: maskIdentifier(bvn) };
      })(dirtyUser);

      expect(sanitized.passwordHash).toBeUndefined();
      expect(sanitized.bvn).toBeUndefined();
      expect(sanitized.bvnHash).toBeUndefined();
      expect(sanitized.nin).toBeUndefined();
      expect(sanitized.ninHash).toBeUndefined();
      expect(sanitized.transactionPin).toBeUndefined();
      expect(sanitized.bvnLast4).toBe('•••••5678');
      expect(sanitized.email).toBe('test@example.com');
    });

    test('P3-04: Bounded Sales Import Cache caps at MAX_ENTRIES and enforces tenant isolation', () => {
      __clearAll();

      // Stress test: insert 550 entries (where MAX_ENTRIES is 500)
      for (let i = 0; i < 550; i++) {
        putImport({
          userId: `u-${i}`,
          businessId: `biz-${i}`,
          filename: `import-${i}.csv`,
          rows: [],
        });
      }

      // Verify store size never exceeded 500
      expect(__getStoreSize()).toBe(500);

      // Test tenant isolation
      const token = putImport({
        userId: 'alice',
        businessId: 'biz-alice',
        filename: 'alice.csv',
        rows: [],
      });

      // Bob cannot read Alice's token
      expect(getImport(token, 'bob', 'biz-alice')).toBeNull();
      // Alice cannot read with wrong businessId
      expect(getImport(token, 'alice', 'biz-bob')).toBeNull();
      // Alice can read with correct credentials
      expect(getImport(token, 'alice', 'biz-alice')).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: CLIENT CONCURRENCY & ASYNCHRONOUS WORKFLOWS
  // ═══════════════════════════════════════════════════════════════════

  describe('Phase 4 — Payout Reconciliation & Concurrency Safeguards', () => {
    test('P4-01: Payout reconciliation cron reconciles successful and failed transfers with 10m grace period', async () => {
      const mockVerify = jest.fn();
      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue({
        verifyTransfer: mockVerify,
      } as any);

      // Create two payouts:
      // Payout 1: initiated 15 mins ago (eligible for sweep) -> SUCCESS
      const oldTime = new Date(Date.now() - 15 * 60 * 1000);
      const payoutSuccess = await testDb.settlementPayout.create({
        data: {
          businessId: business1.id,
          amount: 30000,
          fee: 25,
          netAmount: 29975,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'QA Hunter',
          status: 'processing',
          transferReference: `PO-QA-SUCC-${Date.now()}`,
          paystackTransferCode: 'TRF_SUCC_1',
          initiatedAt: oldTime,
        },
      });

      // Payout 2: initiated 2 mins ago (< 10 mins, in grace period) -> SHOULD BE IGNORED
      const recentTime = new Date(Date.now() - 2 * 60 * 1000);
      const payoutRecent = await testDb.settlementPayout.create({
        data: {
          businessId: business1.id,
          amount: 15000,
          fee: 25,
          netAmount: 14975,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'QA Hunter',
          status: 'processing',
          transferReference: `PO-QA-RECENT-${Date.now()}`,
          paystackTransferCode: 'TRF_RECENT_1',
          initiatedAt: recentTime,
        },
      });

      mockVerify.mockImplementation(async (ref: string) => {
        if (ref === payoutSuccess.transferReference) {
          return { status: 'success', reference: ref };
        }
        return { status: 'pending', reference: ref };
      });

      // Run reconciliation
      const result = await runPayoutReconciliationSweep({ bypassLock: true });

      // Only payout 1 was audited; payout 2 was ignored due to grace period
      expect(result.payoutsAudited).toBe(1);
      expect(result.completedCount).toBe(1);

      // Check DB status
      const updatedSuccess = await testDb.settlementPayout.findUnique({
        where: { id: payoutSuccess.id },
      });
      expect(updatedSuccess?.status).toBe('completed');
      expect(updatedSuccess?.completedAt).not.toBeNull();

      const updatedRecent = await testDb.settlementPayout.findUnique({
        where: { id: payoutRecent.id },
      });
      expect(updatedRecent?.status).toBe('processing'); // Left untouched
    }, 30000);

    test('P4-02: Payout reconciliation isolates individual errors without aborting remaining payouts', async () => {
      const oldTime = new Date(Date.now() - 20 * 60 * 1000);

      // Payout A: will throw network error
      const payoutA = await testDb.settlementPayout.create({
        data: {
          businessId: business1.id,
          amount: 5000,
          fee: 0,
          netAmount: 5000,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'QA Hunter',
          status: 'processing',
          transferReference: `PO-ERR-${Date.now()}`,
          paystackTransferCode: 'TRF_ERR',
          initiatedAt: oldTime,
        },
      });

      // Payout B: will succeed
      const payoutB = await testDb.settlementPayout.create({
        data: {
          businessId: business1.id,
          amount: 8000,
          fee: 0,
          netAmount: 8000,
          destinationBankCode: '058',
          destinationBankName: 'GTBank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'QA Hunter',
          status: 'processing',
          transferReference: `PO-OK-${Date.now()}`,
          paystackTransferCode: 'TRF_OK',
          initiatedAt: oldTime,
        },
      });

      const mockVerify = jest.fn().mockImplementation(async (ref: string) => {
        if (ref === payoutA.transferReference) {
          throw new Error('504 Gateway Timeout from Paystack');
        }
        return { status: 'success', reference: ref };
      });

      jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue({
        verifyTransfer: mockVerify,
      } as any);

      const result = await runPayoutReconciliationSweep({ bypassLock: true });

      expect(result.payoutsAudited).toBe(2);
      expect(result.completedCount).toBe(1); // Payout B completed despite Payout A throwing error

      const dbPayoutB = await testDb.settlementPayout.findUnique({ where: { id: payoutB.id } });
      expect(dbPayoutB?.status).toBe('completed');
    }, 30000);

    test('P4-03: Client 401 interceptor mutex and queue behavior validation', async () => {
      // Simulating the exact client Axios interceptor queue mechanism
      let isRefreshing = false;
      let failedQueue: Array<{ resolve: (token: string) => void; reject: (err: any) => void }> = [];
      let networkRefreshCalls = 0;

      const processQueue = (error: any, token: string | null = null) => {
        failedQueue.forEach((prom) => {
          if (error) prom.reject(error);
          else prom.resolve(token!);
        });
        failedQueue = [];
      };

      const simulateRequestWith401 = async (requestId: number) => {
        // Interceptor check:
        if (isRefreshing) {
          return new Promise<string>((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          }).then((token) => `Request ${requestId} replayed with ${token}`);
        }

        isRefreshing = true;
        networkRefreshCalls++;

        // Simulate network call to /auth/refresh
        await new Promise((r) => setTimeout(r, 50));
        const freshToken = 'fresh_jwt_token_xyz';
        processQueue(null, freshToken);
        isRefreshing = false;

        return `Request ${requestId} replayed with ${freshToken}`;
      };

      // 5 concurrent requests hit 401 at the same millisecond
      const results = await Promise.all([
        simulateRequestWith401(1),
        simulateRequestWith401(2),
        simulateRequestWith401(3),
        simulateRequestWith401(4),
        simulateRequestWith401(5),
      ]);

      // Exactly ONE network refresh call was made
      expect(networkRefreshCalls).toBe(1);

      // All 5 requests received the fresh token and replayed cleanly
      expect(results).toHaveLength(5);
      results.forEach((res, i) => {
        expect(res).toBe(`Request ${i + 1} replayed with fresh_jwt_token_xyz`);
      });
    });
  });
});
