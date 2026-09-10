import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { prisma } from '../../src/lib/prisma';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import { WalletService } from '../../src/services/wallet.service';
import { TypedEventBus } from '../../src/core/events/event-bus';
import { runWalletReconciliationSweep } from '../../src/jobs/wallet-reconciliation.cron';
import { toNumber } from '../../src/shared/helpers/number';
import { Prisma } from '@prisma/client';
import type { Application } from 'express';

describe('Phase 2 Adversarial QA & Stress Torture Suite', () => {
  jest.setTimeout(45000);

  let app: Application;
  let victimUser: any;
  let attackerUser: any;
  let victimBiz: any;
  let victimToken: string;
  let attackerToken: string;

  beforeAll(async () => {
    app = createApp();
    try {
      await prisma.$executeRaw`SELECT pg_advisory_unlock_all()`;
      await testDb.$executeRaw`SELECT pg_advisory_unlock_all()`;
    } catch (_) {}
    await clearDatabase();

    victimUser = await createTestUser('qa-victim@example.com');
    attackerUser = await createTestUser('qa-attacker@example.com');
    victimBiz = await createTestBusiness(victimUser.id, 'Victim Enterprises');

    victimToken = jwt.sign(
      { userId: victimUser.id, email: victimUser.email, role: 'user' },
      config.jwt.accessSecret,
      { expiresIn: '1h' }
    );

    attackerToken = jwt.sign(
      { userId: attackerUser.id, email: attackerUser.email, role: 'user' },
      config.jwt.accessSecret,
      { expiresIn: '1h' }
    );
  }, 45000);

  afterAll(async () => {
    try {
      await prisma.$executeRaw`SELECT pg_advisory_unlock_all()`;
      await testDb.$executeRaw`SELECT pg_advisory_unlock_all()`;
    } catch (_) {}
    await clearDatabase();
    await prisma.$disconnect();
    await testDb.$disconnect();
  }, 45000);

  // ─── 1. Sub-Millisecond Parallel Idempotency Collision ────────
  describe('1. Sub-Millisecond Parallel Idempotency Collision', () => {
    test('10 parallel requests with identical idempotencyKey results in exactly 1 credit and 0 balance drift', async () => {
      const fixedIdempotencyKey = `QA_IDEM_COLLISION_${Date.now()}`;
      const fixedReference = `QA_REF_COLLISION_${Date.now()}`;
      const creditAmount = 25000;

      // Launch 10 simultaneous promises targeting the exact same idempotencyKey
      const parallelRequests = Array.from({ length: 10 }, () =>
        WalletService.creditWallet({
          userId: victimUser.id,
          businessId: victimBiz.id,
          amount: creditAmount,
          fee: 0,
          netAmount: creditAmount,
          reference: fixedReference,
          idempotencyKey: fixedIdempotencyKey,
          source: 'dva',
          description: 'Parallel duplicate webhook attack simulation',
        })
      );

      const results = await Promise.all(parallelRequests);

      // Exactly 1 must have performed the insert (alreadyProcessed = false)
      const newlyProcessed = results.filter((r) => !r.alreadyProcessed);
      const deduplicated = results.filter((r) => r.alreadyProcessed);

      expect(newlyProcessed.length).toBe(1);
      expect(deduplicated.length).toBe(9);

      // Verify the live database state has exactly 1 transaction record
      const txCount = await testDb.walletTransaction.count({
        where: { idempotencyKey: fixedIdempotencyKey },
      });
      expect(txCount).toBe(1);

      // Verify the balance was only credited ONCE
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: victimUser.id },
      });
      expect(toNumber(wallet!.balance)).toBe(creditAmount);
      expect(wallet!.version).toBe(1);
    });
  });

  // ─── 2. Double-Withdrawal Race Condition (Over-Reservation) ───
  describe('2. Double-Withdrawal Race Condition (Over-Reservation Attack)', () => {
    test('Parallel reservations exceeding balance strictly serialize: 1 succeeds, 1 rejected with INSUFFICIENT_FUNDS', async () => {
      // Victim currently has ₦25,000 available
      const attemptAmount = 20000; // Two attempts = ₦40,000 > ₦25,000

      const [res1, res2] = await Promise.allSettled([
        WalletService.reserveFunds({
          userId: victimUser.id,
          amount: attemptAmount,
          reference: `QA_RES_RACE_1_${Date.now()}`,
        }),
        WalletService.reserveFunds({
          userId: victimUser.id,
          amount: attemptAmount,
          reference: `QA_RES_RACE_2_${Date.now()}`,
        }),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Assert the rejection was specifically INSUFFICIENT_FUNDS
      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionReason.message).toMatch(/INSUFFICIENT_FUNDS|Insufficient available wallet balance/i);

      // Verify live wallet state: lockedBalance must be exactly ₦20,000, available ₦5,000
      const wallet = await testDb.walletBalance.findUnique({
        where: { userId: victimUser.id },
      });
      expect(toNumber(wallet!.lockedBalance)).toBe(20000);
      const available = toNumber(wallet!.balance) - toNumber(wallet!.lockedBalance);
      expect(available).toBe(5000);
      expect(available).toBeGreaterThanOrEqual(0);

      // Clean up locked funds for subsequent tests
      await WalletService.releaseLockedFunds({
        userId: victimUser.id,
        amount: attemptAmount,
      });
    });
  });

  // ─── 3. Decimal Precision & Floating-Point Drift Torture ──────
  describe('3. Decimal Precision & Floating-Point Drift Torture', () => {
    test('Accumulates high-precision fractional kobo without IEEE-754 drift', async () => {
      // 0.1 + 0.2 in JS float equals 0.30000000000000004
      // We test fractional credits: ₦100.10, ₦200.20, ₦300.30, ₦400.40
      const initialBalance = (await WalletService.getWalletBalance(victimUser.id)).balance;

      const amounts = [100.1, 200.2, 300.3, 400.4];
      const expectedSum = 1001.0; // 100.10 + 200.20 + 300.30 + 400.40 = 1001.00

      for (let i = 0; i < amounts.length; i++) {
        await WalletService.creditWallet({
          userId: victimUser.id,
          amount: amounts[i],
          fee: 0,
          netAmount: amounts[i],
          reference: `QA_FLOAT_TEST_${Date.now()}_${i}`,
          source: 'dva',
        });
      }

      const finalWallet = await WalletService.getWalletBalance(victimUser.id);
      const added = finalWallet.balance - initialBalance;

      expect(added).toBeCloseTo(expectedSum, 2);
      expect(Number(added.toFixed(2))).toBe(1001.0);
    });
  });

  // ─── 4. Database Physical Index Verification in PostgreSQL ────
  describe('4. Database Physical Index Verification in PostgreSQL Catalog', () => {
    test('verifies sales_transactions_business_id_dva_origin_status_idx exists on the physical table', async () => {
      const indexes = await testDb.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'sales_transactions'
          AND indexname = 'sales_transactions_business_id_dva_origin_status_idx'
      `;

      expect(indexes.length).toBe(1);
      expect(indexes[0].indexname).toBe('sales_transactions_business_id_dva_origin_status_idx');
      expect(indexes[0].indexdef).toContain('business_id');
      expect(indexes[0].indexdef).toContain('dva_origin');
      expect(indexes[0].indexdef).toContain('status');
    });
  });

  // ─── 5. Database Foreign Key Constraints & Integrity ──────────
  describe('5. Database Foreign Key Constraints & Integrity', () => {
    test('PostgreSQL enforces foreign key on wallet_transactions.user_id', async () => {
      const fakeUserId = '00000000-0000-0000-0000-000000000000';
      const fakeWalletId = '00000000-0000-0000-0000-000000000000';

      await expect(
        testDb.walletTransaction.create({
          data: {
            walletId: fakeWalletId,
            userId: fakeUserId,
            amount: new Prisma.Decimal(1000),
            netAmount: new Prisma.Decimal(1000),
            balanceAfter: new Prisma.Decimal(1000),
            reference: `QA_FK_TEST_${Date.now()}`,
            source: 'test',
          },
        })
      ).rejects.toThrow();
    });
  });

  // ─── 6. Cross-Tenant Security & Query Injection Torture ───────
  describe('6. Cross-Tenant Security & Query Injection Torture', () => {
    test('SQL injection payloads in history query type parameter are blocked by Zod schema', async () => {
      const sqlInjectionRes = await request(app)
        .get("/api/v1/wallet/history?type=credit' OR '1'='1")
        .set('Authorization', `Bearer ${victimToken}`);

      expect(sqlInjectionRes.status).toBe(400);
      expect(sqlInjectionRes.body.error).toBeDefined();
    });

    test('Negative pagination values are safely rejected by validation', async () => {
      const negativeRes = await request(app)
        .get('/api/v1/wallet/history?page=-5&limit=0')
        .set('Authorization', `Bearer ${victimToken}`);

      expect(negativeRes.status).toBe(400);
    });

    test('Excessive limit values (>100) are rejected by Zod validation guard', async () => {
      const oversizedRes = await request(app)
        .get('/api/v1/wallet/history?limit=5000')
        .set('Authorization', `Bearer ${victimToken}`);

      expect(oversizedRes.status).toBe(400);
    });

    test('Attacker supplying victim businessId receives 0 records (tenant isolation holds)', async () => {
      const crossTenantRes = await request(app)
        .get(`/api/v1/wallet/history?businessId=${victimBiz.id}`)
        .set('Authorization', `Bearer ${attackerToken}`);

      expect(crossTenantRes.status).toBe(200);
      // Must be 0 because attacker cannot see transactions owned by victimUser
      expect(crossTenantRes.body.data).toHaveLength(0);
      expect(crossTenantRes.body.pagination.total).toBe(0);
    });

    test('Tampered or forged JWT signature is completely rejected (401)', async () => {
      const forgedToken = victimToken.slice(0, -5) + 'xxxxx';

      const res = await request(app)
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(res.status).toBe(401);
    });
  });

  // ─── 7. EventBus Error Isolation & Multi-Listener Resilience ──
  describe('7. EventBus Error Isolation & Multi-Listener Resilience', () => {
    test('EventBus dispatches to 20 listeners even when multiple listeners throw errors', async () => {
      const bus = new TypedEventBus();
      let successCount = 0;
      let failureCount = 0;

      // Register 20 listeners, every 4th listener throws an error
      for (let i = 0; i < 20; i++) {
        if (i % 4 === 0) {
          bus.on('wallet.credited', () => {
            failureCount++;
            throw new Error(`Intentional QA listener exception #${i}`);
          });
        } else {
          bus.on('wallet.credited', () => {
            successCount++;
          });
        }
      }

      // Emitting must not throw to the caller
      expect(() => {
        bus.emit('wallet.credited', {
          userId: 'test-user',
          amount: 5000,
          transactionId: 'tx-test',
        });
      }).not.toThrow();

      // Yield event loop
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 5 failing listeners executed
      expect(failureCount).toBe(5);
      // All 15 healthy listeners executed without being blocked by errors
      expect(successCount).toBe(15);

      bus.removeAllListeners();
    });
  });

  // ─── 8. Reconciler Tampering Detection Under Active Attack ────
  describe('8. Reconciler Tampering Detection Under Active Attack', () => {
    test('Nightly reconciliation sweep detects unauthorized out-of-band SQL balance update', async () => {
      // Simulate an insider or attacker performing a direct SQL update to mint ₦50,000 out of thin air
      await testDb.$executeRaw`
        UPDATE wallet_balances
        SET balance = balance + 50000
        WHERE user_id = ${victimUser.id}
      `;

      // Run reconciliation sweep with bypassLock: true
      const result = await runWalletReconciliationSweep({ bypassLock: true });

      // The reconciler must catch the exact ledger mismatch
      expect(result.ledgerMismatchCount).toBeGreaterThanOrEqual(1);

      // Revert the simulated tampering to restore clean ledger state
      await testDb.$executeRaw`
        UPDATE wallet_balances
        SET balance = balance - 50000
        WHERE user_id = ${victimUser.id}
      `;

      // Second sweep must find 0 ledger mismatches for the victim
      const cleanResult = await runWalletReconciliationSweep({ bypassLock: true });
      expect(cleanResult.ledgerMismatchCount).toBe(0);
    });
  });
});
