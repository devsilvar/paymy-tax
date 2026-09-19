// Nightly Wallet Reconciliation Sweep — runs at 01:00 Africa/Lagos.
//
// Invariants enforced:
//   1. WalletBalance.balance == Σ(WalletTransaction.netAmount) for recorded transactions.
//   2. Shadow Mode Oracle: WalletBalance.balance == getPayoutPreview().availableForWithdrawal.
//      Any drift > ₦0.01 triggers an immediate high-priority warning log for administrative review.
//
// Concurrency:
//   Wrapped in Postgres transaction-scoped advisory lock (LOCK_KEY = 947363).
//   Uses pg_try_advisory_xact_lock inside $transaction fence so PostgreSQL
//   automatically releases the lock upon commit or rollback without leaking
//   session locks across connection poolers (PgBouncer/Neon/Supabase).
//   Guarantees single execution across clustered/multi-container deployments.

import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { config } from '../config';
import { toNumber } from '../shared/helpers/number';
import { getPayoutPreview } from '../services/settlement/payout-preview.service';
import { getPaymentProvider } from '../lib/payment';
import { logAudit } from '../lib/audit';

// Arbitrary 32-bit int. Registered in lock key directory:
//   947362 — daily reminder sweep (reminders.cron.ts)
//   947363 — wallet reconciliation sweep (wallet-reconciliation.cron.ts)
const LOCK_KEY = 947363;

const SCHEDULE = '0 1 * * *';
const TIMEZONE = 'Africa/Lagos';

export function registerWalletReconciliationCron(): void {
  if (!config.cron.enabled) {
    logger.info(
      'Wallet reconciliation cron skipped (set ENABLE_CRON=true to enable in non-production)'
    );
    return;
  }

  cron.schedule(
    SCHEDULE,
    () => {
      void runWalletReconciliationSweep();
    },
    { timezone: TIMEZONE }
  );
  logger.info('Wallet reconciliation cron registered', { schedule: SCHEDULE, timezone: TIMEZONE });
}

export interface WalletReconciliationResult {
  usersAudited: number;
  ledgerMismatchCount: number;
  oracleDriftCount: number;
  totalDriftNaira: number;
  // Invariant 3: Gateway Solvency Oracle
  totalLiabilitiesNaira: number;
  gatewayBalanceNaira: number;
  reserveRatio: number;
  isSolvent: boolean;
  solvencyDeficitNaira: number;
  gatewayReachable: boolean;
}

export async function runWalletReconciliationSweep(opts?: {
  bypassLock?: boolean;
}): Promise<WalletReconciliationResult> {
  if (opts?.bypassLock) {
    return await executeReconciliation();
  }

  return await prisma.$transaction(
    async (tx) => {
      const lockResult = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
      `;
      const locked = lockResult[0]?.locked === true;

      if (!locked) {
        logger.warn('Wallet reconciliation sweep skipped — another worker holds the lock', {
          lockKey: LOCK_KEY,
        });
        return {
          usersAudited: 0,
          ledgerMismatchCount: 0,
          oracleDriftCount: 0,
          totalDriftNaira: 0,
          totalLiabilitiesNaira: 0,
          gatewayBalanceNaira: 0,
          reserveRatio: 1.0,
          isSolvent: true,
          solvencyDeficitNaira: 0,
          gatewayReachable: false,
        };
      }

      return await executeReconciliation();
    },
    { maxWait: 10000, timeout: 60000 }
  );
}

async function executeReconciliation(): Promise<WalletReconciliationResult> {
  logger.info('Starting nightly wallet reconciliation sweep');

  const wallets = await prisma.walletBalance.findMany({
    include: {
      user: {
        select: {
          id: true,
          email: true,
          businesses: {
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  // Batch query all wallet transaction sums by userId in a single query (eliminates N+1 loop)
  const txAggs = await prisma.walletTransaction.groupBy({
    by: ['userId'],
    _sum: { netAmount: true },
    _count: { _all: true },
  });

  const txAggMap = new Map(
    txAggs.map((agg) => [
      agg.userId,
      {
        sumNetAmount: toNumber(agg._sum.netAmount ?? 0),
        count: agg._count._all,
      },
    ])
  );

  let usersAudited = 0;
  let ledgerMismatchCount = 0;
  let oracleDriftCount = 0;
  let totalDriftNaira = 0;

  for (const wallet of wallets) {
    usersAudited++;
    const currentBalance = toNumber(wallet.balance);

    // Invariant 1: Internal Ledger Consistency (indexed from pre-aggregated batch map)
    const txAgg = txAggMap.get(wallet.userId);
    if (txAgg && txAgg.count > 0) {
      const sumNetAmount = txAgg.sumNetAmount;
      const internalDrift = Math.abs(currentBalance - sumNetAmount);
      if (internalDrift > 0.01) {
        ledgerMismatchCount++;
        logger.error('[WALLET_LEDGER_MISMATCH] WalletBalance does not match transaction sum', {
          userId: wallet.userId,
          walletBalance: currentBalance,
          txSum: sumNetAmount,
          drift: internalDrift,
        });
      }
    }

    // Invariant 2: Shadow Mode Oracle comparison against getPayoutPreview
    const primaryBusiness = wallet.user.businesses[0];
    if (primaryBusiness) {
      try {
        const preview = await getPayoutPreview(wallet.userId, primaryBusiness.id);
        const oracleAvailable = preview.availableForWithdrawal;
        const oracleDrift = Math.abs(currentBalance - oracleAvailable);

        if (oracleDrift > 0.01) {
          oracleDriftCount++;
          totalDriftNaira += oracleDrift;
          logger.warn('[WALLET_SHADOW_ORACLE_DRIFT] Drift detected against getPayoutPreview oracle', {
            userId: wallet.userId,
            userEmail: wallet.user.email,
            walletBalance: currentBalance,
            oracleAvailable,
            driftNaira: oracleDrift,
          });
        }
      } catch (err: any) {
        logger.error('Failed to run oracle getPayoutPreview for user during reconciliation', {
          userId: wallet.userId,
          error: err.message,
        });
      }
    }
  }

  // ── Invariant 3: Real-Time 1:1 Gateway Liquid Reserve Solvency Oracle ──
  let totalLiabilitiesNaira = 0;
  let gatewayBalanceNaira = 0;
  let reserveRatio = 1.0;
  let isSolvent = true;
  let solvencyDeficitNaira = 0;
  let gatewayReachable = true;

  try {
    const obligationsResult = await prisma.walletBalance.aggregate({
      _sum: {
        balance: true,
        lockedBalance: true,
      },
    });
    totalLiabilitiesNaira =
      toNumber(obligationsResult._sum.balance ?? 0) +
      toNumber(obligationsResult._sum.lockedBalance ?? 0);

    const provider = getPaymentProvider();
    const balances = await provider.getBalance();
    const ngnItem = balances.find((b) => b.currency === 'NGN');
    gatewayBalanceNaira = ngnItem ? ngnItem.balanceNaira : 0;

    if (totalLiabilitiesNaira > 0) {
      reserveRatio = gatewayBalanceNaira / totalLiabilitiesNaira;
      if (gatewayBalanceNaira < totalLiabilitiesNaira) {
        isSolvent = false;
        solvencyDeficitNaira = totalLiabilitiesNaira - gatewayBalanceNaira;

        logger.error(
          '[CUSTODY_SOLVENCY_DEFICIT] CRITICAL: Live gateway balance is insufficient to back merchant liabilities',
          { totalLiabilitiesNaira, gatewayBalanceNaira, reserveRatio, solvencyDeficitNaira }
        );

        logAudit({
          action: 'settlement.solvency_deficit_detected',
          resourceType: 'PlatformSolvency',
          resourceId: 'live_reserve',
          newData: { totalLiabilitiesNaira, gatewayBalanceNaira, reserveRatio, solvencyDeficitNaira },
        });
      } else {
        logger.info('[CUSTODY_SOLVENCY_CONFIRMED] Gateway reserve 1:1 backing verified', {
          totalLiabilitiesNaira,
          gatewayBalanceNaira,
          reserveRatio: `${(reserveRatio * 100).toFixed(2)}%`,
        });
      }
    }
  } catch (err: any) {
    gatewayReachable = false;
    logger.error('[SOLVENCY_ORACLE_QUERY_FAILED] Failed to verify gateway liquid reserves', {
      error: err.message,
    });
    // Do NOT set isSolvent=false on network errors — that would be a false alarm.
    // The operator sees gatewayReachable=false in the result and the error log.
  }

  logger.info('Wallet reconciliation sweep complete', {
    usersAudited,
    ledgerMismatchCount,
    oracleDriftCount,
    totalDriftNaira,
    totalLiabilitiesNaira,
    gatewayBalanceNaira,
    reserveRatio,
    isSolvent,
    solvencyDeficitNaira,
    gatewayReachable,
  });

  return {
    usersAudited,
    ledgerMismatchCount,
    oracleDriftCount,
    totalDriftNaira,
    totalLiabilitiesNaira,
    gatewayBalanceNaira,
    reserveRatio,
    isSolvent,
    solvencyDeficitNaira,
    gatewayReachable,
  };
}


