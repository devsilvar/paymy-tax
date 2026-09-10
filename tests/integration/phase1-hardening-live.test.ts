import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import { getWithdrawalActor } from '../../src/shared/helpers/withdrawal-actor';
import { assertMonthNotLocked } from '../../src/shared/helpers/month-lock';
import { toNumber } from '../../src/shared/helpers/number';
import { SETTLED_SALE_STATUSES, TAXABLE_SALES_WHERE } from '../../src/shared/helpers/settled-status';
import * as salesService from '../../src/services/sales.service';
import * as taxService from '../../src/services/tax.service';
import { Prisma } from '@prisma/client';
import { AppError } from '../../src/middleware/errorHandler';

/**
 * Phase 1 Live Database Hardening & Canonical Helpers Verification Suite
 *
 * This test suite executes against the real PostgreSQL database (NO MOCKS).
 * It empirically proves:
 * 1. getWithdrawalActor live un-cached query behavior, PIN lockout detection, and multi-tenant isolation.
 * 2. assertMonthNotLocked UTC date boundary enforcement and 423 PERIOD_LOCKED / PERIOD_FINALIZED rejection.
 * 3. SETTLED_SALE_STATUSES vs TAXABLE_SALES_WHERE real DB partition logic (confirmed/completed vs taxable).
 * 4. Alignment between salesService.getMonthlySummary (gross vs taxable) and taxService.calculateTax.
 * 5. toNumber precision and edge case handling with real Prisma Decimal instances.
 */
describe('Phase 1 Live Database Hardening & Helper Verification', () => {
  let user1: any;
  let user2: any;
  let business1: any;
  let business2: any;

  beforeAll(async () => {
    await clearDatabase();

    user1 = await createTestUser('qa-auditor-1@example.com');
    user2 = await createTestUser('qa-auditor-2@example.com');

    business1 = await createTestBusiness(user1.id, 'Live Audit Alpha Ltd');
    business2 = await createTestBusiness(user2.id, 'Live Audit Beta Ltd');
  }, 30000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 30000);

  // ─── 1. Live getWithdrawalActor Security & Cache Bypass ───────

  describe('1. Live getWithdrawalActor Security & Cache Bypass', () => {
    test('retrieves live business and user security fields directly from DB', async () => {
      // Configure settlement details on user1
      await testDb.user.update({
        where: { id: user1.id },
        data: {
          settlementBankCode: '058',
          settlementBankName: 'Guaranty Trust Bank',
          settlementAccountNumber: '0123456789',
          settlementAccountName: 'LIVE AUDIT ALPHA LTD',
          pinAttempts: 0,
          pinLockedUntil: null,
        },
      });

      const actor = await getWithdrawalActor(user1.id, business1.id);

      expect(actor.id).toBe(business1.id);
      expect(actor.user.id).toBe(user1.id);
      expect(actor.user.settlementBankCode).toBe('058');
      expect(actor.user.settlementAccountNumber).toBe('0123456789');
      expect(actor.user.pinLockedUntil).toBeNull();
      expect(actor.user.pinAttempts).toBe(0);
    }, 30000);

    test('rejection: cannot access another user business (cross-tenant isolation)', async () => {
      // user2 attempting to act on user1's business
      await expect(
        getWithdrawalActor(user2.id, business1.id)
      ).rejects.toThrow(AppError);

      try {
        await getWithdrawalActor(user2.id, business1.id);
      } catch (err: any) {
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('BUSINESS_NOT_FOUND');
      }
    }, 30000);

    test('CRITICAL: reflects PIN lockout immediately in real DB without cache lag', async () => {
      // Step A: actor is currently unlocked
      const beforeLock = await getWithdrawalActor(user1.id, business1.id);
      expect(beforeLock.user.pinLockedUntil).toBeNull();

      // Step B: simulate 3 failed PIN attempts resulting in lock until 30 minutes in future
      const lockExpiry = new Date(Date.now() + 30 * 60 * 1000);
      await testDb.user.update({
        where: { id: user1.id },
        data: {
          pinAttempts: 3,
          pinLockedUntil: lockExpiry,
        },
      });

      // Step C: immediate subsequent call MUST reflect the lock without 60-second cache delay
      const afterLock = await getWithdrawalActor(user1.id, business1.id);
      expect(afterLock.user.pinAttempts).toBe(3);
      expect(afterLock.user.pinLockedUntil).not.toBeNull();
      expect(new Date(afterLock.user.pinLockedUntil!).getTime()).toBe(lockExpiry.getTime());
    }, 30000);

    test('operates safely within a Prisma transaction client', async () => {
      await testDb.$transaction(async (tx) => {
        const actor = await getWithdrawalActor(user1.id, business1.id, tx);
        expect(actor.id).toBe(business1.id);
        expect(actor.user.id).toBe(user1.id);
      });
    }, 30000);
  });

  // ─── 2. Live assertMonthNotLocked UTC & Status Enforcement ────

  describe('2. Live assertMonthNotLocked UTC & Status Enforcement', () => {
    const marchDate = new Date('2026-03-20T14:30:00Z');
    const marchMonthStart = new Date(Date.UTC(2026, 2, 1));
    const aprilDate = new Date('2026-04-05T09:00:00Z');

    test('allows transaction when no report exists for the month', async () => {
      await expect(
        assertMonthNotLocked(business1.id, marchDate)
      ).resolves.toBeUndefined();
    }, 30000);

    test('allows transaction when report is draft (unfinalized and unlocked)', async () => {
      await testDb.monthlyTaxReport.create({
        data: {
          businessId: business1.id,
          taxMonth: marchMonthStart,
          totalSales: 100000,
          totalExpenses: 20000,
          grossProfit: 80000,
          taxRate: 7.5,
          taxPayable: 6000,
          profitMargin: 80,
          isFinalized: false,
          isLocked: false,
          paymentStatus: 'pending',
        },
      });

      await expect(
        assertMonthNotLocked(business1.id, marchDate)
      ).resolves.toBeUndefined();
    }, 30000);

    test('rejects with 423 PERIOD_FINALIZED when report is finalized', async () => {
      await testDb.monthlyTaxReport.update({
        where: {
          businessId_taxMonth: {
            businessId: business1.id,
            taxMonth: marchMonthStart,
          },
        },
        data: { isFinalized: true },
      });

      await expect(
        assertMonthNotLocked(business1.id, marchDate)
      ).rejects.toThrow(AppError);

      try {
        await assertMonthNotLocked(business1.id, marchDate);
      } catch (err: any) {
        expect(err.statusCode).toBe(423);
        expect(err.code).toBe('PERIOD_FINALIZED');
      }
    }, 30000);

    test('rejects with 423 PERIOD_LOCKED when report is locked (tax paid)', async () => {
      await testDb.monthlyTaxReport.update({
        where: {
          businessId_taxMonth: {
            businessId: business1.id,
            taxMonth: marchMonthStart,
          },
        },
        data: { isFinalized: true, isLocked: true, paymentStatus: 'completed' },
      });

      await expect(
        assertMonthNotLocked(business1.id, marchDate)
      ).rejects.toThrow(AppError);

      try {
        await assertMonthNotLocked(business1.id, marchDate);
      } catch (err: any) {
        expect(err.statusCode).toBe(423);
        expect(err.code).toBe('PERIOD_LOCKED');
      }
    }, 30000);

    test('month isolation: locking March does NOT lock April', async () => {
      // April has no locked report
      await expect(
        assertMonthNotLocked(business1.id, aprilDate)
      ).resolves.toBeUndefined();
    }, 30000);
  });

  // ─── 3. Real Database Queries: SETTLED vs TAXABLE Partitioning ───

  describe('3. Database Queries: SETTLED vs TAXABLE Partitioning', () => {
    beforeAll(async () => {
      // Clean previous transactions
      await testDb.salesTransaction.deleteMany({ where: { businessId: business2.id } });
      await testDb.expense.deleteMany({ where: { businessId: business2.id } });

      const testDate = new Date('2026-05-15T12:00:00Z');

      // Insert 5 test sales with distinct status / taxability combinations
      // 1. Confirmed + Taxable -> 100,000 NGN (Settled: YES, Tax: YES)
      await testDb.salesTransaction.create({
        data: {
          businessId: business2.id,
          amount: 100000,
          source: 'pos',
          status: 'confirmed',
          isTaxable: true,
          transactionDate: testDate,
          description: 'Product Sale 1',
        },
      });

      // 2. Completed + Taxable -> 50,000 NGN (Settled: YES, Tax: YES)
      await testDb.salesTransaction.create({
        data: {
          businessId: business2.id,
          amount: 50000,
          source: 'manual',
          status: 'completed',
          isTaxable: true,
          transactionDate: testDate,
          description: 'Legacy Manual Sale',
        },
      });

      // 3. Confirmed + NON-TAXABLE -> 200,000 NGN (Settled: YES, Tax: NO - e.g. Capital / Loan)
      await testDb.salesTransaction.create({
        data: {
          businessId: business2.id,
          amount: 200000,
          source: 'bank_transfer',
          status: 'confirmed',
          isTaxable: false,
          transactionDate: testDate,
          description: 'Director Loan Injection',
        },
      });

      // 4. Pending + Taxable -> 75,000 NGN (Settled: NO, Tax: NO)
      await testDb.salesTransaction.create({
        data: {
          businessId: business2.id,
          amount: 75000,
          source: 'bank_transfer',
          status: 'pending',
          isTaxable: true,
          transactionDate: testDate,
          description: 'Unverified DVA transfer',
        },
      });

      // 5. Reversed + Taxable -> 30,000 NGN (Settled: NO, Tax: NO)
      await testDb.salesTransaction.create({
        data: {
          businessId: business2.id,
          amount: 30000,
          source: 'pos',
          status: 'reversed',
          isTaxable: true,
          transactionDate: testDate,
          description: 'Refunded POS payment',
        },
      });

      // Add 1 Deductible Expense -> 30,000 NGN
      await testDb.expense.create({
        data: {
          businessId: business2.id,
          amount: 30000,
          category: 'rent',
          description: 'Office rent May 2026',
          expenseDate: testDate,
          isDeductible: true,
        },
      });
    }, 30000);

    test('raw DB query using SETTLED_SALE_STATUSES returns confirmed + completed regardless of taxability', async () => {
      const settled = await testDb.salesTransaction.findMany({
        where: {
          businessId: business2.id,
          status: { in: SETTLED_SALE_STATUSES },
        },
      });

      // Rows 1 (100k), 2 (50k), 3 (200k)
      expect(settled).toHaveLength(3);
      const totalSettled = settled.reduce((acc, row) => acc + Number(row.amount), 0);
      expect(totalSettled).toBe(350000);
    }, 30000);

    test('raw DB query using TAXABLE_SALES_WHERE filters strictly to settled AND taxable', async () => {
      const taxable = await testDb.salesTransaction.findMany({
        where: {
          businessId: business2.id,
          ...TAXABLE_SALES_WHERE,
        },
      });

      // Only Rows 1 (100k) and 2 (50k)
      expect(taxable).toHaveLength(2);
      const totalTaxable = taxable.reduce((acc, row) => acc + Number(row.amount), 0);
      expect(totalTaxable).toBe(150000);
    }, 30000);

    test('salesService.getMonthlySummary accurately calculates both gross totalSales and taxableSales', async () => {
      const summary = await salesService.getMonthlySummary(
        user2.id,
        business2.id,
        5,
        2026
      );

      // totalSales = 350,000 (all confirmed/completed revenue in cash/bank)
      expect(Number(summary.totalSales)).toBe(350000);
      // taxableSales = 150,000 (excluding 200,000 non-taxable loan)
      expect(Number(summary.taxableSales)).toBe(150000);
      // transactionCount = 5 total transactions recorded in this month (3 settled, 1 pending, 1 reversed)
      expect(summary.transactionCount).toBe(5);
    }, 30000);

    test('taxService.calculateTax engine strictly bases 7.5% FIRS tax on taxableSales only', async () => {
      const report = await taxService.calculateTax(
        user2.id,
        business2.id,
        5,
        2026
      );

      // Taxable sales = 150,000
      expect(Number(report.totalSales)).toBe(150000);
      // Deductible expenses = 30,000
      expect(Number(report.totalExpenses)).toBe(30000);
      // Gross Profit = 150,000 - 30,000 = 120,000
      expect(Number(report.grossProfit)).toBe(120000);
      // Tax Payable (7.5%) = 120,000 * 0.075 = 9,000
      expect(Number(report.taxPayable)).toBe(9000);
    }, 30000);
  });

  // ─── 4. Real Prisma.Decimal Precision & toNumber Verification ──

  describe('4. Real Prisma.Decimal Precision & toNumber Verification', () => {
    test('accurately parses real Prisma.Decimal instances without precision loss', () => {
      const decimalVal = new Prisma.Decimal('14500000.75');
      const num = toNumber(decimalVal);
      expect(num).toBe(14500000.75);
    });

    test('handles zero, negative, and string decimal values correctly', () => {
      expect(toNumber(new Prisma.Decimal('0.00'))).toBe(0);
      expect(toNumber(new Prisma.Decimal('-520.50'))).toBe(-520.5);
      expect(toNumber('98765.43')).toBe(98765.43);
      expect(toNumber(null)).toBe(0);
      expect(toNumber(undefined)).toBe(0);
      expect(toNumber(NaN)).toBe(0);
    });
  });
});
