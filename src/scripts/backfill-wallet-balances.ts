import { prisma } from '../lib/prisma';
import { toNumber } from '../shared/helpers/number';
import { SETTLED_SALE_STATUSES } from '../shared/helpers/settled-status';
import { dvaFeeCapThreshold } from '../lib/paystack-fees';
import { Prisma } from '@prisma/client';
import logger from '../lib/logger';

async function backfillWalletBalances() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`\n======================================================`);
  console.log(`Starting Wallet Balance Backfill (${isDryRun ? 'DRY RUN' : 'LIVE WRITE'})`);
  console.log(`======================================================\n`);

  // Step 1: Ensure dva_origin is backfilled
  const dvaUpdate = await prisma.$executeRaw`
    UPDATE "sales_transactions"
    SET "dva_origin" = true
    WHERE ("dva_origin" = false OR "dva_origin" IS NULL)
      AND (
        (metadata->>'channel' = 'dva')
        OR ("source" = 'bank_transfer' AND metadata->>'autoRecorded' = 'true')
      );
  `;
  console.log(`[Step 1] Synchronized dva_origin: updated ${dvaUpdate} sales transactions.`);

  // Step 2: Query all users with their businesses
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      businesses: {
        select: { id: true, businessName: true },
      },
    },
  });

  console.log(`[Step 2] Processing ${users.length} users across the platform...\n`);

  let totalBackfilledUsers = 0;
  let totalBalanceAcrossPlatform = 0;

  for (const user of users) {
    const userBizIds = user.businesses.map((b) => b.id);
    if (userBizIds.length === 0) {
      continue;
    }

    // Platform-held share of split-settled inflows
    const splitAgg = await prisma.salesTransaction.aggregate({
      where: {
        businessId: { in: userBizIds },
        source: 'bank_transfer',
        dvaOrigin: true,
        status: { in: [...SETTLED_SALE_STATUSES] },
        settledViaSplit: true,
      },
      _sum: {
        platformRetained: true,
      },
    });
    const totalPlatformRetained = toNumber(splitAgg._sum.platformRetained ?? 0);

    // Plain (non-split) inflows count in full
    const plainAgg = await prisma.salesTransaction.aggregate({
      where: {
        businessId: { in: userBizIds },
        source: 'bank_transfer',
        dvaOrigin: true,
        status: { in: [...SETTLED_SALE_STATUSES] },
        settledViaSplit: false,
      },
      _sum: {
        amount: true,
      },
    });
    const totalPlainInflows = toNumber(plainAgg._sum.amount ?? 0);
    const platformHeldInflows = totalPlainInflows + totalPlatformRetained;

    // Modelled Paystack processing fees
    let estimatedProcessingFees = 0;
    const capThreshold = dvaFeeCapThreshold();
    if (Number.isFinite(capThreshold)) {
      const dvaBase: Prisma.SalesTransactionWhereInput = {
        businessId: { in: userBizIds },
        source: 'bank_transfer',
        dvaOrigin: true,
        status: { in: [...SETTLED_SALE_STATUSES] },
      };

      const plainBelow = await prisma.salesTransaction.aggregate({
        where: { ...dvaBase, settledViaSplit: false, amount: { lte: capThreshold } },
        _sum: { amount: true },
      });
      const plainAbove = await prisma.salesTransaction.count({
        where: { ...dvaBase, settledViaSplit: false, amount: { gt: capThreshold } },
      });

      const splitBelow = await prisma.salesTransaction.aggregate({
        where: { ...dvaBase, settledViaSplit: true, platformRetained: { lte: capThreshold } },
        _sum: { platformRetained: true },
      });
      const splitAbove = await prisma.salesTransaction.count({
        where: { ...dvaBase, settledViaSplit: true, platformRetained: { gt: capThreshold } },
      });

      estimatedProcessingFees =
        (toNumber(plainBelow._sum.amount ?? 0) * 0.01) +
        (plainAbove * 300) +
        (toNumber(splitBelow._sum.platformRetained ?? 0) * 0.01) +
        (splitAbove * 300);
    }

    // Deduct completed withdrawals
    const completedPayoutsAgg = await prisma.settlementPayout.aggregate({
      where: {
        businessId: { in: userBizIds },
        status: 'completed',
      },
      _sum: {
        amount: true,
        fee: true,
      },
    });
    const totalCompletedPayouts =
      toNumber(completedPayoutsAgg._sum.amount ?? 0) +
      toNumber(completedPayoutsAgg._sum.fee ?? 0);

    // Sum pending withdrawals for lockedBalance
    const pendingPayoutsAgg = await prisma.settlementPayout.aggregate({
      where: {
        businessId: { in: userBizIds },
        status: { in: ['pending', 'processing'] },
      },
      _sum: {
        amount: true,
        fee: true,
      },
    });
    const totalPendingPayouts =
      toNumber(pendingPayoutsAgg._sum.amount ?? 0) +
      toNumber(pendingPayoutsAgg._sum.fee ?? 0);

    const netPlatformBalance = Math.max(
      0,
      platformHeldInflows - estimatedProcessingFees - totalCompletedPayouts
    );

    console.log(
      `User ${user.email} (${user.id}):` +
      ` Inflows=₦${platformHeldInflows.toFixed(2)},` +
      ` Fees=₦${estimatedProcessingFees.toFixed(2)},` +
      ` Payouts=₦${totalCompletedPayouts.toFixed(2)}` +
      ` -> Net Balance: ₦${netPlatformBalance.toFixed(2)}` +
      ` (Locked: ₦${totalPendingPayouts.toFixed(2)})`
    );

    if (!isDryRun) {
      await prisma.walletBalance.upsert({
        where: { userId: user.id },
        update: {
          balance: new Prisma.Decimal(netPlatformBalance),
          lockedBalance: new Prisma.Decimal(totalPendingPayouts),
          updatedAt: new Date(),
        },
        create: {
          userId: user.id,
          balance: new Prisma.Decimal(netPlatformBalance),
          lockedBalance: new Prisma.Decimal(totalPendingPayouts),
          currency: 'NGN',
          version: 1,
        },
      });
    }

    totalBackfilledUsers++;
    totalBalanceAcrossPlatform += netPlatformBalance;
  }

  console.log(`\n======================================================`);
  console.log(`Backfill Complete!`);
  console.log(`Users evaluated: ${totalBackfilledUsers}`);
  console.log(`Total Platform Treasury: ₦${totalBalanceAcrossPlatform.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (No database rows modified)' : 'COMMITTED (Database updated)'}`);
  console.log(`======================================================\n`);
}

backfillWalletBalances()
  .catch((err) => {
    console.error('Backfill error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
