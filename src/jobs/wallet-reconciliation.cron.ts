// Nightly Wallet Reconciliation Sweep — runs at 01:00 Africa/Lagos.
//
// Invariants enforced:
//   1. WalletBalance.balance == Σ(WalletTransaction.netAmount) for recorded transactions.
//   2. Shadow Mode Oracle: WalletBalance.balance == getPayoutPreview().availableForWithdrawal.
//      Any drift > ₦0.01 triggers an immediate high-priority warning log for administrative review.
//
// Concurrency:
//   Wrapped in Postgres advisory lock (LOCK_KEY = 947363).
//   Guarantees single execution across clustered/multi-container deployments.

import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { config } from '../config';
import { toNumber } from '../shared/helpers/number';
import { getPayoutPreview } from '../services/settlement.service';

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

export async function runWalletReconciliationSweep(opts?: {
  bypassLock?: boolean;
}): Promise<{
  usersAudited: number;
  ledgerMismatchCount: number;
  oracleDriftCount: number;
  totalDriftNaira: number;
}> {
  if (!opts?.bypassLock) {
    const lockResult = await prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
    `;
    const locked = lockResult[0]?.locked === true;

    if (!locked) {
      logger.warn('Wallet reconciliation sweep skipped — another worker holds the lock', {
        lockKey: LOCK_KEY,
      });
      return { usersAudited: 0, ledgerMismatchCount: 0, oracleDriftCount: 0, totalDriftNaira: 0 };
    }
  }

  try {
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

    let usersAudited = 0;
    let ledgerMismatchCount = 0;
    let oracleDriftCount = 0;
    let totalDriftNaira = 0;

    for (const wallet of wallets) {
      usersAudited++;
      const currentBalance = toNumber(wallet.balance);

      // Invariant 1: Internal Ledger Consistency (if user has WalletTransactions)
      const txAgg = await prisma.walletTransaction.aggregate({
        where: { userId: wallet.userId },
        _sum: { netAmount: true },
        _count: true,
      });

      if (txAgg._count > 0) {
        const sumNetAmount = toNumber(txAgg._sum.netAmount ?? 0);
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

    logger.info('Wallet reconciliation sweep complete', {
      usersAudited,
      ledgerMismatchCount,
      oracleDriftCount,
      totalDriftNaira,
    });

    return { usersAudited, ledgerMismatchCount, oracleDriftCount, totalDriftNaira };
  } finally {
    if (!opts?.bypassLock) {
      try {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
      } catch (unlockErr) {
        logger.warn('Wallet reconciliation sweep: advisory unlock failed', {
          error: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
        });
      }
    }
  }
}
