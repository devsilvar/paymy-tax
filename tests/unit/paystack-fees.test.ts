import { describe, test, expect, afterEach } from '@jest/globals';
import config from '@/config';
import {
  dvaFeeCapThreshold,
  dvaFeeTotalFromBuckets,
  dvaProcessingFee,
  feeSchedule,
  quoteWithdrawal,
  stampDuty,
  transferFee,
  withdrawalCost,
  withdrawalFeeBearer,
} from '@/lib/paystack-fees';

/**
 * Paystack fee model.
 *
 * These assertions are pinned to Paystack's PUBLISHED pricing, so if someone
 * edits config.paystack.fees the suite tells them they have just changed what
 * the business charges. Sources (all fetched 2026-09-03) are in the header of
 * src/lib/paystack-fees.ts:
 *   • DVA inflow 1% capped ₦300 — support.paystack.com/en/articles/2124866
 *   • Transfer bands ₦10/₦25/₦50 — support.paystack.com/en/articles/2130370
 *   • ₦50 stamp duty ≥ ₦10,000 — support.paystack.com/en/articles/7573314
 */

// Guard: this suite asserts the defaults. If a deploy overrides them via env,
// fail loudly rather than silently testing a different fee schedule.
const f = config.paystack.fees;

describe('Paystack fee config defaults', () => {
  test('match the published schedule', () => {
    expect(f.dvaPct).toBe(1);
    expect(f.dvaCap).toBe(300);
    expect(f.transferLow).toBe(10);
    expect(f.transferLowMax).toBe(5000);
    expect(f.transferMid).toBe(25);
    expect(f.transferMidMax).toBe(50000);
    expect(f.transferHigh).toBe(50);
    expect(f.stampDuty).toBe(50);
    expect(f.stampDutyFrom).toBe(10000);
    expect(f.withdrawalFeeBearer).toBe('merchant');
  });
});

describe('DVA inflow fee — 1% capped at ₦300', () => {
  test('charges 1% below the cap', () => {
    expect(dvaProcessingFee(1000)).toBe(10);
    expect(dvaProcessingFee(10000)).toBe(100);
    expect(dvaProcessingFee(29999)).toBe(299.99);
  });

  test('caps at ₦300', () => {
    expect(dvaProcessingFee(30000)).toBe(300);
    expect(dvaProcessingFee(500000)).toBe(300);
    expect(dvaProcessingFee(50_000_000)).toBe(300);
  });

  test('is zero for nothing / nonsense', () => {
    expect(dvaProcessingFee(0)).toBe(0);
    expect(dvaProcessingFee(-500)).toBe(0);
    expect(dvaProcessingFee(NaN)).toBe(0);
  });

  test('cap threshold is ₦30,000 at 1%/₦300', () => {
    expect(dvaFeeCapThreshold()).toBe(30000);
  });

  test('bucket totals reproduce per-row fees exactly', () => {
    // 3 transfers under the cap (₦1,000 + ₦10,000 + ₦29,000) + 2 over it.
    const bucketTotal = dvaFeeTotalFromBuckets(1000 + 10000 + 29000, 2);
    const rowByRow =
      dvaProcessingFee(1000) +
      dvaProcessingFee(10000) +
      dvaProcessingFee(29000) +
      dvaProcessingFee(60000) +
      dvaProcessingFee(1_000_000);
    expect(bucketTotal).toBeCloseTo(rowByRow, 2);
    expect(bucketTotal).toBe(400 + 600); // ₦400 of 1% + 2 × ₦300 cap
  });
});

describe('Transfer-out fee — banded flat fee, not a percentage', () => {
  test('₦10 up to ₦5,000', () => {
    expect(transferFee(100)).toBe(10);
    expect(transferFee(5000)).toBe(10);
  });

  test('₦25 from ₦5,001 to ₦50,000', () => {
    expect(transferFee(5000.01)).toBe(25);
    expect(transferFee(50000)).toBe(25);
  });

  test('₦50 above ₦50,000', () => {
    expect(transferFee(50000.01)).toBe(50);
    expect(transferFee(1_000_000)).toBe(50);
  });

  test('it is NOT 1% — a ₦1m withdrawal still costs ₦50', () => {
    expect(transferFee(1_000_000)).not.toBe(10_000);
  });
});

describe('Stamp duty — ₦50 on transfers of ₦10,000+', () => {
  test('does not apply below ₦10,000', () => {
    expect(stampDuty(9999.99)).toBe(0);
    expect(stampDuty(5000)).toBe(0);
  });

  test('applies from ₦10,000 up', () => {
    expect(stampDuty(10000)).toBe(50);
    expect(stampDuty(1_000_000)).toBe(50);
  });
});

describe('Total withdrawal cost', () => {
  test('₦5,000 → ₦10 (fee only)', () => {
    expect(withdrawalCost(5000)).toBe(10);
  });

  test('₦25,000 → ₦75 (₦25 fee + ₦50 duty)', () => {
    expect(withdrawalCost(25000)).toBe(75);
  });

  test("Paystack's own worked example: ₦100,000 debits ₦100,100", () => {
    // https://support.paystack.com/en/articles/7573314 — "Paystack Fee ₦50 +
    // Stamp Duty ₦50 = ₦100".
    expect(withdrawalCost(100000)).toBe(100);
  });
});

describe('quoteWithdrawal — WallX 1% fee capped at ₦300 (merchant bears fee)', () => {
  test('calculates 1% fee on ₦1,000 (min floor)', () => {
    const q = quoteWithdrawal(1000);
    expect(q.bearer).toBe('merchant');
    expect(q.amount).toBe(1000);
    expect(q.fee).toBe(10);
    expect(q.netAmount).toBe(990);
    expect(q.paystackAmount).toBe(990);
  });

  test('calculates 1% fee on ₦10,000', () => {
    const q = quoteWithdrawal(10000);
    expect(q.fee).toBe(100);
    expect(q.netAmount).toBe(9900);
    expect(q.amount).toBe(10000);
  });

  test('caps fee at ₦300 on amounts ₦30,000 and above', () => {
    const q30k = quoteWithdrawal(30000);
    expect(q30k.fee).toBe(300);
    expect(q30k.netAmount).toBe(29700);

    const q50k = quoteWithdrawal(50000);
    expect(q50k.fee).toBe(300);
    expect(q50k.netAmount).toBe(49700);

    const q100k = quoteWithdrawal(100000);
    expect(q100k.fee).toBe(300);
    expect(q100k.netAmount).toBe(99700);
  });

  test('refuses amounts below the ₦1,000 floor', () => {
    expect(() => quoteWithdrawal(999)).toThrow(/minimum withdrawal/i);
    expect(() => quoteWithdrawal(500)).toThrow(/minimum withdrawal/i);
    expect(() => quoteWithdrawal(100)).toThrow(/minimum withdrawal/i);
    expect(quoteWithdrawal(0).amount).toBe(0);
  });
});

describe('quoteWithdrawal — platform bears the fee', () => {
  const original = config.paystack.fees.withdrawalFeeBearer;

  afterEach(() => {
    (config.paystack.fees as { withdrawalFeeBearer: string }).withdrawalFeeBearer = original;
  });

  test('SME receives the full amount and the ledger absorbs the 1% capped fee', () => {
    (config.paystack.fees as { withdrawalFeeBearer: string }).withdrawalFeeBearer = 'platform';
    expect(withdrawalFeeBearer()).toBe('platform');

    const q10k = quoteWithdrawal(10000);
    expect(q10k.netAmount).toBe(10000);
    expect(q10k.fee).toBe(100);
    expect(q10k.amount).toBe(10100);

    const q100k = quoteWithdrawal(100000);
    expect(q100k.netAmount).toBe(100000);
    expect(q100k.fee).toBe(300); // Capped at 300
    expect(q100k.amount).toBe(100300);
  });
});

describe('feeSchedule — what the API exposes to the client', () => {
  test('describes both sides including 1% rate and ₦300 cap', () => {
    const s = feeSchedule();
    expect(s.currency).toBe('NGN');
    expect(s.minWithdrawal).toBe(1000);
    expect(s.dvaInflow).toMatchObject({ pct: 1, cap: 300, borneBy: 'merchant' });
    expect(s.withdrawal.ratePct).toBe(1);
    expect(s.withdrawal.cap).toBe(300);
    expect(s.withdrawal.minAmount).toBe(1000);
  });
});