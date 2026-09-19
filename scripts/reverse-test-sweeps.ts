import prisma from '../src/lib/prisma';
import { WalletService } from '../src/services/wallet/wallet.service';
import { toNumber } from '../src/shared/helpers/number';
import { logAudit } from '../src/lib/audit';

async function main() {
  console.log('🔍 Locating test-mode auto-sweep payouts to reverse...\n');

  const sweepPayouts = await prisma.settlementPayout.findMany({
    where: {
      transferReference: { startsWith: 'SWEEP-' },
      status: { in: ['completed', 'processing'] },
    },
    include: {
      business: {
        select: { id: true, businessName: true, userId: true, user: { select: { email: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (sweepPayouts.length === 0) {
    console.log('✅ No active sweep payouts found to reverse.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${sweepPayouts.length} sweep payout(s) to reverse:\n`);

  for (const payout of sweepPayouts) {
    const amount = toNumber(payout.amount);
    const userId = payout.business.userId;
    const userEmail = payout.business.user?.email;

    console.log(`  📋 Payout ${payout.id}`);
    console.log(`     Reference: ${payout.transferReference}`);
    console.log(`     User:      ${userEmail} (${userId})`);
    console.log(`     Business:  ${payout.business.businessName}`);
    console.log(`     Amount:    ₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`);
    console.log(`     Status:    ${payout.status}`);

    const reversalRef = `REV-${payout.transferReference}`;

    try {
      const { wallet, alreadyProcessed } = await WalletService.creditWallet({
        userId,
        businessId: payout.business.id,
        amount,
        fee: 0,
        netAmount: amount,
        reference: reversalRef,
        source: 'reversal',
        type: 'reversal',
        description: `Reversal of test-mode auto-sweep ${payout.transferReference} (sk_test_*)`,
        metadata: {
          reversedPayoutId: payout.id,
          originalAmount: amount,
          reason: 'test_mode_sweep_reversal',
        },
      });

      if (alreadyProcessed) {
        console.log(`     ⚠️  Already reversed (idempotent skip)\n`);
        continue;
      }

      // If it was processing, release any lingering locked balance
      if (payout.status === 'processing') {
        await WalletService.releaseLockedFunds({
          userId,
          amount,
          fee: 0,
        });
        console.log(`     🔓 Released locked funds`);
      }

      // Update payout status to refunded
      await prisma.settlementPayout.update({
        where: { id: payout.id },
        data: {
          status: 'refunded',
          failureReason: 'Reversed: test-mode sweep. Real money did not move (sk_test_* keys).',
          updatedAt: new Date(),
        },
      });

      // Audit log
      await logAudit({
        userId,
        businessId: payout.business.id,
        action: 'settlement.test_sweep_reversed',
        resourceType: 'settlement_payout',
        resourceId: payout.id,
        newData: {
          reversalReference: reversalRef,
          creditedBack: amount,
          walletBalanceAfter: toNumber(wallet.balance),
        },
      });

      console.log(`     ✅ Reversed! Credited ₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} back to wallet`);
      console.log(`     💰 Balance after credit: ₦${toNumber(wallet.balance).toLocaleString('en-NG', { minimumFractionDigits: 2 })}\n`);
    } catch (err: any) {
      console.error(`     ❌ Failed to reverse: ${err.message}\n`);
    }
  }

  // Self-heal and display final balances for all affected users
  const allUsers = [...new Set(sweepPayouts.map((p) => p.business.userId))];
  console.log('--- Final wallet balances (after self-healing & reconciliation) ---');
  for (const uid of allUsers) {
    const bal = await WalletService.getWalletBalance(uid);
    const user = await prisma.user.findUnique({ where: { id: uid }, select: { email: true } });
    console.log(`  User: ${user?.email}`);
    console.log(`    Total Balance:     ₦${bal.balance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`);
    console.log(`    Available Balance: ₦${bal.availableBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`);
    console.log(`    Locked Balance:    ₦${bal.lockedBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}\n`);
  }

  await prisma.$disconnect();
  console.log('🎉 Done! All test sweeps reversed and balances restored.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
