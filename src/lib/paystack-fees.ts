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
 * Who absorbs the cost of a withdrawal.
 *  - 'merchant' (default): the fee comes out of what the SME asked for. They ask
 *    for ₦100,000, receive ₦99,900, and the platform balance drops by exactly
 *    ₦100,000 — which is what Paystack debits (net + fee(net)).
 *  - 'platform': the SME receives every naira they asked for and the platform
 *    eats the fee. Ledger debit = amount + fee.
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
  /** Transfer fee + stamp duty Paystack will keep. */
  fee: number;
  /** What actually lands in the SME's commercial bank account. */
  netAmount: number;
  /** The value to send as `amount` to Paystack's POST /transfer. */
  paystackAmount: number;
  bearer: WithdrawalFeeBearer;
}

/**
 * Prices a withdrawal so the ledger and Paystack's balance never drift.
 *
 * Paystack debits `paystackAmount + fee(paystackAmount)` from the balance, so in
 * merchant mode we solve for the net amount whose fee-inclusive cost equals what
 * the SME asked for. The fee is banded, so one pass can land in a different band
 * — iterate until it settles (it converges in ≤3 steps because the fee only ever
 * takes four distinct values).
 *
 * @throws when the requested amount is too small to cover the fee at all.
 */
export function quoteWithdrawal(requestedNaira: number): WithdrawalQuote {
  const bearer = withdrawalFeeBearer();
  const requested = round2(Number(requestedNaira) || 0);

  if (requested <= 0) {
    return { requested: 0, amount: 0, fee: 0, netAmount: 0, paystackAmount: 0, bearer };
  }

  if (bearer === 'platform') {
    const fee = withdrawalCost(requested);
    return {
      requested,
      amount: round2(requested + fee),
      fee,
      netAmount: requested,
      paystackAmount: requested,
      bearer,
    };
  }

  // The banded fee has a floor, so a request smaller than that floor can never
  // be priced — reject it instead of looping between bands forever.
  const floorFee = withdrawalCost(requested);
  if (floorFee >= requested) {
    throw new Error(
      `Amount too small to cover Paystack's ₦${floorFee.toFixed(2)} withdrawal cost`
    );
  }

  let net = requested;
  let fee = floorFee;
  for (let i = 0; i < 8; i += 1) {
    const nextNet = round2(requested - fee);
    const nextFee = withdrawalCost(nextNet);
    if (nextNet === net && nextFee === fee) break;
    net = nextNet;
    fee = nextFee;
  }

  // Never hand back a quote whose parts do not add up — the ledger and
  // Paystack's balance would drift apart by whatever the rounding gap is.
  if (round2(net + withdrawalCost(net)) !== requested) {
    throw new Error(
      `Could not price a ₦${requested.toFixed(2)} withdrawal against the current fee bands`
    );
  }

  return { requested, amount: requested, fee, netAmount: net, paystackAmount: net, bearer };
}

/**
 * Human/machine-readable description of the schedule, safe to hand to the
 * frontend so the UI never hardcodes a naira figure.
 */
export function feeSchedule() {
  const f = fees();
  return {
    currency: 'NGN',
    dvaInflow: {
      pct: f.dvaPct,
      cap: f.dvaCap,
      borneBy: 'merchant' as const,
      note:
        'Paystack deducts this from each dedicated-virtual-account transfer before it settles. It is not added to what the sender pays.',
    },
    withdrawal: {
      bearer: withdrawalFeeBearer(),
      bands: [
        { upTo: f.transferLowMax, fee: f.transferLow },
        { upTo: f.transferMidMax, fee: f.transferMid },
        { upTo: null, fee: f.transferHigh },
      ],
      stampDuty: { amount: f.stampDuty, from: f.stampDutyFrom },
      note:
        'Paystack debits the transfer fee plus stamp duty from the platform balance, on top of the amount transferred.',
    },
  };
}

export { round2 };
