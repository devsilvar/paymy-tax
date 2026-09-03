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

describe('quoteWithdrawal — merchant bears the fee (default)', () => {
  test('ledger debit equals what the SME asked for', () => {
    const q = quoteWithdrawal(100000);
    expect(q.bearer).toBe('merchant');
    expect(q.amount).toBe(100000);
    expect(q.fee).toBe(100);
    expect(q.netAmount).toBe(99900);
  });

  test('the quote reconciles with what Paystack actually debits', () => {
    // Paystack debits netAmount + fee(netAmount); that must equal `amount`.
    const q = quoteWithdrawal(100000);
    expect(q.paystackAmount + withdrawalCost(q.paystackAmount)).toBeCloseTo(q.amount, 2);
  });

  test('re-prices when the net amount falls into a cheaper band', () => {
    // ₦10,000 asks for the ₦25+₦50 band, but the net lands under ₦10,000 where
    // the ₦50 stamp duty no longer applies — the quote must settle on ₦25.
    const q = quoteWithdrawal(10000);
    expect(q.fee).toBe(25);
    expect(q.netAmount).toBe(9975);
    expect(q.paystackAmount + withdrawalCost(q.paystackAmount)).toBeCloseTo(10000, 2);
  });

  test('reconciles across the whole band range', () => {
    for (const amount of [100, 500, 4999, 5000, 5001, 9999, 10000, 49999, 50000, 50001, 250000, 1_000_000]) {
      const q = quoteWithdrawal(amount);
      expect(q.amount).toBe(amount);
      expect(q.netAmount).toBeGreaterThan(0);
      expect(q.paystackAmount + withdrawalCost(q.paystackAmount)).toBeCloseTo(amount, 2);
    }
  });

  test('refuses amounts the fee would swallow', () => {
    expect(() => quoteWithdrawal(10)).toThrow(/too small/i);
    expect(() => quoteWithdrawal(0)).not.toThrow();
  });
});

describe('quoteWithdrawal — platform bears the fee', () => {
  const original = config.paystack.fees.withdrawalFeeBearer;

  afterEach(() => {
    (config.paystack.fees as { withdrawalFeeBearer: string }).withdrawalFeeBearer = original;
  });

  test('SME receives the full amount and the ledger absorbs the fee', () => {
    (config.paystack.fees as { withdrawalFeeBearer: string }).withdrawalFeeBearer = 'platform';
    expect(withdrawalFeeBearer()).toBe('platform');

    const q = quoteWithdrawal(100000);
    expect(q.netAmount).toBe(100000);
    expect(q.paystackAmount).toBe(100000);
    expect(q.fee).toBe(100);
    expect(q.amount).toBe(100100);
    // Still reconciles: Paystack debits 100,000 + 100 = the ledger debit.
    expect(q.paystackAmount + withdrawalCost(q.paystackAmount)).toBeCloseTo(q.amount, 2);
  });
});

describe('feeSchedule — what the API exposes to the client', () => {
  test('describes both sides without hardcoding into the frontend', () => {
    const s = feeSchedule();
    expect(s.currency).toBe('NGN');
    expect(s.dvaInflow).toMatchObject({ pct: 1, cap: 300, borneBy: 'merchant' });
    expect(s.withdrawal.bands).toEqual([
      { upTo: 5000, fee: 10 },
      { upTo: 50000, fee: 25 },
      { upTo: null, fee: 50 },
    ]);
    expect(s.withdrawal.stampDuty).toEqual({ amount: 50, from: 10000 });
  });
});
