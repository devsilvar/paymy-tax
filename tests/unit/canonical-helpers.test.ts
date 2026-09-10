import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
  toNumber,
  assertMonthNotLocked,
  isMonthLockedOrFinalized,
  resolveTransactionDateForLockedMonth,
  SETTLED_SALE_STATUSES,
  TAXABLE_SALES_WHERE,
} from '../../src/shared/helpers';

import prisma, { TxClient } from '../../src/lib/prisma';
import { AppError } from '../../src/middleware/errorHandler';

describe('Canonical Helpers Unit Tests', () => {
  describe('toNumber', () => {
    test('converts null and undefined to 0', () => {
      expect(toNumber(null)).toBe(0);
      expect(toNumber(undefined)).toBe(0);
    });

    test('passes numbers through directly', () => {
      expect(toNumber(0)).toBe(0);
      expect(toNumber(12345)).toBe(12345);
      expect(toNumber(-50.75)).toBe(-50.75);
    });

    test('parses numeric strings and handles invalid strings gracefully', () => {
      expect(toNumber('100')).toBe(100);
      expect(toNumber('2500.50')).toBe(2500.5);
      expect(toNumber('0')).toBe(0);
      expect(toNumber('')).toBe(0);
      expect(toNumber('invalid-number')).toBe(0);
    });

    test('calls .toNumber() on Prisma Decimal-like objects', () => {
      const decimalLike = {
        toNumber: () => 75000.25,
      };
      expect(toNumber(decimalLike)).toBe(75000.25);
    });

    test('falls back to Number() conversion when .toNumber is not a function', () => {
      const obj = { valueOf: () => 42 };
      expect(toNumber(obj)).toBe(42);
    });
  });

  describe('SETTLED_SALE_STATUSES & TAXABLE_SALES_WHERE', () => {
    test('SETTLED_SALE_STATUSES contains canonical confirmed and legacy completed', () => {
      expect(SETTLED_SALE_STATUSES).toEqual(['confirmed', 'completed']);
      expect(SETTLED_SALE_STATUSES).toContain('confirmed');
      expect(SETTLED_SALE_STATUSES).toContain('completed');
      expect(SETTLED_SALE_STATUSES).not.toContain('pending');
      expect(SETTLED_SALE_STATUSES).not.toContain('reversed');
    });

    test('TAXABLE_SALES_WHERE correctly constructs Prisma filter predicate', () => {
      expect(TAXABLE_SALES_WHERE).toEqual({
        status: { in: ['confirmed', 'completed'] },
        isTaxable: true,
      });
    });
  });

  describe('assertMonthNotLocked', () => {
    const mockBusinessId = 'biz-test-uuid';
    const sampleDate = new Date('2026-03-15T12:00:00Z');

    beforeEach(() => {
      jest.restoreAllMocks();
    });

    test('does not throw when no tax report exists for the given month', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue(null as any);

      await expect(
        assertMonthNotLocked(mockBusinessId, sampleDate)
      ).resolves.toBeUndefined();
    });

    test('does not throw when report is neither finalized nor locked', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        id: 'report-1',
        isFinalized: false,
        isLocked: false,
      } as any);

      await expect(
        assertMonthNotLocked(mockBusinessId, sampleDate)
      ).resolves.toBeUndefined();
    });

    test('throws AppError 423 PERIOD_LOCKED when isLocked is true', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        id: 'report-1',
        isLocked: true,
        isFinalized: true,
      } as any);

      await expect(
        assertMonthNotLocked(mockBusinessId, sampleDate)
      ).rejects.toThrow(AppError);

      try {
        await assertMonthNotLocked(mockBusinessId, sampleDate);
      } catch (err: any) {
        expect(err.statusCode).toBe(423);
        expect(err.code).toBe('PERIOD_LOCKED');
      }
    });

    test('throws AppError 423 PERIOD_FINALIZED when isFinalized is true but not locked', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        id: 'report-1',
        isLocked: false,
        isFinalized: true,
      } as any);

      await expect(
        assertMonthNotLocked(mockBusinessId, sampleDate)
      ).rejects.toThrow(AppError);

      try {
        await assertMonthNotLocked(mockBusinessId, sampleDate);
      } catch (err: any) {
        expect(err.statusCode).toBe(423);
        expect(err.code).toBe('PERIOD_FINALIZED');
      }
    });

    test('uses provided transaction client tx instead of default prisma', async () => {
      const mockTx = {
        monthlyTaxReport: {
          findUnique: jest.fn().mockResolvedValue(null as any),
        },
      } as unknown as TxClient;

      const prismaSpy = jest.spyOn(prisma.monthlyTaxReport, 'findUnique');

      await assertMonthNotLocked(mockBusinessId, sampleDate, mockTx);

      expect(mockTx.monthlyTaxReport.findUnique).toHaveBeenCalledTimes(1);
      expect(prismaSpy).not.toHaveBeenCalled();
    });
  });

  describe('isMonthLockedOrFinalized & resolveTransactionDateForLockedMonth', () => {
    const mockBusinessId = 'biz-test-uuid';
    const sampleDate = new Date('2026-02-15T12:00:00Z');

    beforeEach(() => {
      jest.restoreAllMocks();
    });

    test('isMonthLockedOrFinalized returns false when report is absent or open', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue(null as any);
      const res = await isMonthLockedOrFinalized(mockBusinessId, sampleDate);
      expect(res.isLocked).toBe(false);
      expect(res.isFinalized).toBe(false);
      expect(res.lockedOrFinalized).toBe(false);
    });

    test('isMonthLockedOrFinalized returns true when report is locked or finalized', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        isLocked: true,
        isFinalized: true,
      } as any);
      const res = await isMonthLockedOrFinalized(mockBusinessId, sampleDate);
      expect(res.isLocked).toBe(true);
      expect(res.lockedOrFinalized).toBe(true);
    });

    test('resolveTransactionDateForLockedMonth keeps original date if month is open', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue(null as any);
      const result = await resolveTransactionDateForLockedMonth(mockBusinessId, sampleDate);
      expect(result.wasAdjusted).toBe(false);
      expect(result.effectiveDate).toBe(sampleDate);
      expect(result.originalDate).toBeUndefined();
    });

    test('resolveTransactionDateForLockedMonth rolls date forward to current month if locked', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        isLocked: true,
        isFinalized: true,
      } as any);

      const before = new Date();
      const result = await resolveTransactionDateForLockedMonth(mockBusinessId, sampleDate);
      const after = new Date();

      expect(result.wasAdjusted).toBe(true);
      expect(result.originalDate).toBe(sampleDate);
      expect(result.effectiveDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
      expect(result.effectiveDate.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
      expect(result.reason).toContain('locked tax period');
    });

    test('resolveTransactionDateForLockedMonth rolls date forward if finalized but not locked', async () => {
      jest.spyOn(prisma.monthlyTaxReport, 'findUnique').mockResolvedValue({
        isLocked: false,
        isFinalized: true,
      } as any);

      const result = await resolveTransactionDateForLockedMonth(mockBusinessId, sampleDate);

      expect(result.wasAdjusted).toBe(true);
      expect(result.originalDate).toBe(sampleDate);
      expect(result.reason).toContain('finalized tax period');
    });
  });
});

