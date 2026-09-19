/**
 * Paystack fee model — the single source of truth for every naira Paystack takes.
 *
 * Verified against Paystack's own published pricing on 2026-09-03.
 *
 * ─── 1. DEDICATED VIRTUAL ACCOUNT (DVA) INFLOWS ──────────────────────────────
 * 1% per transfer, capped at ₦300.
 *   • https://support.paystack.com/en/articles/2124866
 *       "The charge per transaction is 1%, capped at NGN 300."
 *   • https://paystack.com/pricing
 *       "Dedicated Virtual Accounts (DVA) — 1% per transaction (capped at NGN 300)"
 *
 * WHO PAYS IT: the merchant, not the sender. Paystack debits it from the
 * transfer and settles the difference:
 *   • https://support.paystack.com/en/articles/2130306
 *       "Transaction charges are deducted per transaction, and we settle the
 *        difference via your payouts"
 * No stamp duty is added on the receiving side — the sender's own bank may
 * charge them one, but that never touches our balance:
 *   • https://support.paystack.com/en/articles/7573314
 *       "Does this charge apply to both inflows and outflows? No. This charge
 *        only applies to outflows (transfers you send)."
 *
 * ─── 2. TRANSFERS OUT (withdrawals) ─────────────────────────────────────────
 * A banded FLAT fee — not a percentage of the amount:
 *       ≤ ₦5,000          → ₦10
 *       ₦5,001 – ₦50,000  → ₦25
 *       > ₦50,000         → ₦50
 *   • https://support.paystack.com/en/articles/2130370
 *       "Transfers charges are deducted from your Paystack Balance."
 *
 * ─── 3. STAMP DUTY ──────────────────────────────────────────────────────────
 * Flat ₦50 on every transfer of ₦10,000 or more sent from a Paystack balance,
 * charged ON TOP of the transfer fee, effective 18 Feb 2026 (Nigeria Tax Act
 * 2025). Government levy — Paystack does not keep it and it is not refundable.
 *   • https://support.paystack.com/en/articles/7573314
 *       "If I transfer ₦100,000 … your balance will be debited a total of
 *        ₦100,100 … Paystack Fee ₦50 + Stamp Duty ₦50."
 *
 * Every number is env-overridable (config.paystack.fees) so a pricing change is
 * a config deploy rather than a code change — but if Paystack moves a number,
 * update this doc block too. It is the audit trail.
 */

import config from '@/config';

export type WithdrawalFeeBearer = 'merchant' | 'platform';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const fees = () => config.paystack.fees;

/**
 * Who bears the WallX withdrawal fee.
 *  - 'merchant' (default): the fee is an ADDITIVE surcharge paid by the SME.
 *    Wallet debit = requested + fee. The full requested amount lands in the
 *    SME's bank account. This is the production default.
 *  - 'platform': the platform absorbs the fee entirely. Wallet debit = requested.
 *    The SME receives their full requested amount and pays nothing extra.
 */
export function withdrawalFeeBearer(): WithdrawalFeeBearer {
  return fees().withdrawalFeeBearer === 'platform' ? 'platform' : 'merchant';
}

/**
 * Fee Paystack takes on money paid INTO a dedicated virtual account.
 * min(1% of the transfer, ₦300).
 */
export function dvaProcessingFee(amountNaira: number): number {
  const amount = Number(amountNaira);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const { dvaPct, dvaCap } = fees();
  return round2(Math.min((amount * dvaPct) / 100, dvaCap));
}

/**
 * Amount at which the DVA fee hits its cap (₦300 / 1% = ₦30,000 today).
 * Used to total fees across many rows with two aggregates instead of N.
 */
export function dvaFeeCapThreshold(): number {
  const { dvaPct, dvaCap } = fees();
  if (dvaPct <= 0) return Infinity;
  return dvaCap / (dvaPct / 100);
}

/**
 * Exact total DVA fee over a set of transfers, given the two buckets split at
 * {@link dvaFeeCapThreshold}:
 *   pct/100 * Σ(below-cap amounts) + cap * count(above-cap rows)
 */
export function dvaFeeTotalFromBuckets(
  belowCapSum: number,
  aboveCapCount: number
): number {
  const { dvaPct, dvaCap } = fees();
  const sum = Number(belowCapSum) || 0;
  const count = Number(aboveCapCount) || 0;
  return round2((sum * dvaPct) / 100 + count * dvaCap);
}

/** Paystack's flat transfer fee for a withdrawal of `amountNaira`. */
export function transferFee(amountNaira: number): number {
  const amount = Number(amountNaira);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const f = fees();
  if (amount <= f.transferLowMax) return f.transferLow;
  if (amount <= f.transferMidMax) return f.transferMid;
  return f.transferHigh;
}

/** Government stamp duty on a withdrawal of `amountNaira`. */
export function stampDuty(amountNaira: number): number {
  const amount = Number(amountNaira);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const f = fees();
  return f.stampDuty > 0 && amount >= f.stampDutyFrom ? f.stampDuty : 0;
}

/** Everything Paystack + the government take to move `amountNaira` out. */
export function withdrawalCost(amountNaira: number): number {
  return round2(transferFee(amountNaira) + stampDuty(amountNaira));
}

export interface WithdrawalQuote {
  /** What the SME typed in. */
  requested: number;
  /** Debited from the platform-held ledger balance. */
  amount: number;
  /** WallX platform withdrawal fee (1% capped at ₦300). */
  fee: number;
  /** What actually lands in the SME's commercial bank account. */
  netAmount: number;
  /** The value to send as `amount` to Paystack's POST /transfer. */
  paystackAmount: number;
  bearer: WithdrawalFeeBearer;
}

/**
 * Prices a withdrawal.
 *
 * In merchant mode (default), the fee is additive: the wallet is debited
 * requested + fee, and Paystack receives the full requested amount for
 * transfer to the SME's bank. In platform mode, the wallet is debited
 * only the requested amount and the platform absorbs the fee cost.
 *
 * @throws when the requested amount is below the minimum withdrawal floor.
 */
export const MIN_WITHDRAWAL_AMOUNT = 1000.00;
export const WALLX_WITHDRAWAL_PCT = 1.0; // 1%
export const WALLX_WITHDRAWAL_CAP = 300.00; // ₦300 cap

export interface FeeConfigOptions {
  pct?: number;
  cap?: number;
  minAmount?: number;
}

export function wallxWithdrawalFee(amountNaira: number, config?: FeeConfigOptions): number {
  const amount = Number(amountNaira);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const pct = config?.pct !== undefined ? config.pct : WALLX_WITHDRAWAL_PCT;
  const cap = config?.cap !== undefined ? config.cap : WALLX_WITHDRAWAL_CAP;
  return round2(Math.min((amount * pct) / 100, cap));
}

/**
 * Prices a withdrawal with configurable WallX fee (default: 1% capped at ₦300).
 *
 * @throws when the requested amount is below the minimum withdrawal floor.
 */
export function quoteWithdrawal(requestedNaira: number, config?: FeeConfigOptions): WithdrawalQuote {
  const bearer = withdrawalFeeBearer();
  const requested = round2(Number(requestedNaira) || 0);

  if (requested <= 0) {
    return { requested: 0, amount: 0, fee: 0, netAmount: 0, paystackAmount: 0, bearer };
  }

  const minFloor = config?.minAmount !== undefined ? config.minAmount : MIN_WITHDRAWAL_AMOUNT;
  if (requested < minFloor) {
    throw new Error(
      `Minimum withdrawal amount is ₦${minFloor.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`
    );
  }

  const fee = wallxWithdrawalFee(requested, config);

  if (bearer === 'platform') {
    // Platform absorbs: SME is not charged any extra fee.
    // Wallet debit = requested only. Bank gets the full requested amount.
    return {
      requested,
      amount: requested,
      fee,
      netAmount: requested,
      paystackAmount: requested,
      bearer,
    };
  }

  // Merchant mode (default, additive surcharge):
  // Fee rides on top — wallet debit = requested + fee.
  // The full requested amount lands in the SME's bank account.
  const totalDebit = round2(requested + fee);
  return {
    requested,
    amount: totalDebit,
    fee,
    netAmount: requested,
    paystackAmount: requested,
    bearer,
  };
}

/**
 * Prices a wallet auto-sweep where the TOTAL wallet debit is capped at available balance.
 * Solves for `requested` such that `requested + fee <= available`.
 * Guarantees that sweeping will never trigger an overdraft or INSUFFICIENT_FUNDS error.
 */
export function quoteAutoSweep(
  availableNaira: number,
  config?: FeeConfigOptions
): WithdrawalQuote {
  const bearer = withdrawalFeeBearer();
  const available = round2(Number(availableNaira) || 0);

  if (available <= 0) {
    return { requested: 0, amount: 0, fee: 0, netAmount: 0, paystackAmount: 0, bearer };
  }

  const minFloor = config?.minAmount !== undefined ? config.minAmount : MIN_WITHDRAWAL_AMOUNT;

  if (bearer === 'platform') {
    if (available < minFloor) {
      throw new Error(
        `Available balance ₦${available.toFixed(2)} is below minimum withdrawal ₦${minFloor.toFixed(2)}`
      );
    }
    const fee = wallxWithdrawalFee(available, config);
    return {
      requested: available,
      amount: available,
      fee,
      netAmount: available,
      paystackAmount: available,
      bearer,
    };
  }

  // Merchant mode (additive surcharge): solve for requested such that requested + fee <= available
  const pct = config?.pct !== undefined ? config.pct : WALLX_WITHDRAWAL_PCT;
  const cap = config?.cap !== undefined ? config.cap : WALLX_WITHDRAWAL_CAP;

  let requested = round2(available / (1 + pct / 100));
  // If fee hits cap, solve using cap directly
  if (round2((requested * pct) / 100) >= cap) {
    requested = round2(available - cap);
  }

  let fee = wallxWithdrawalFee(requested, config);
  while (round2(requested + fee) > available && requested > 0) {
    requested = round2(requested - 0.01);
    fee = wallxWithdrawalFee(requested, config);
  }

  if (requested < minFloor) {
    throw new Error(
      `Swept net amount ₦${requested.toFixed(2)} after fees is below minimum withdrawal ₦${minFloor.toFixed(2)}`
    );
  }

  const totalDebit = round2(requested + fee);
  return {
    requested,
    amount: totalDebit,
    fee,
    netAmount: requested,
    paystackAmount: requested,
    bearer,
  };
}

/**
 * Human/machine-readable description of the schedule, safe to hand to the
 * frontend so the UI never hardcodes a naira figure.
 */
export function feeSchedule(config?: FeeConfigOptions) {
  const f = fees();
  const ratePct = config?.pct !== undefined ? config.pct : WALLX_WITHDRAWAL_PCT;
  const cap = config?.cap !== undefined ? config.cap : WALLX_WITHDRAWAL_CAP;
  const minAmount = config?.minAmount !== undefined ? config.minAmount : MIN_WITHDRAWAL_AMOUNT;
  return {
    currency: 'NGN',
    minWithdrawal: minAmount,
    dvaInflow: {
      pct: f.dvaPct,
      cap: f.dvaCap,
      borneBy: 'platform' as const,
      note: 'Platform absorbs Paystack DVA processing fees in full. Customer receives 100% credit.',
    },
    withdrawal: {
      bearer: withdrawalFeeBearer(),
      ratePct,
      ratePercent: ratePct,
      cap,
      capAmount: cap,
      minAmount,
      bands: [
        { upTo: f.transferLowMax, fee: f.transferLow },
        { upTo: f.transferMidMax, fee: f.transferMid },
        { upTo: null, fee: f.transferHigh },
      ],
      stampDuty: { amount: f.stampDuty, from: f.stampDutyFrom },
      note: `Withdrawal fee: ${ratePct}% capped at ₦${cap.toLocaleString('en-NG', { minimumFractionDigits: 2 })} per withdrawal.`,
    },
  };
}

export { round2 };