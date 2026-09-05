/**
 * Reverse Test Payout Script
 *
 * Transitions the ₦200 test payout from 'completed' → 'failed' so the
 * wallet balance is restored. Creates an audit log entry and an in-app
 * notification reminder. Safe, idempotent — re-running is a no-op if
 * the payout is already 'failed'.
 *
 * Usage:
 *   npx tsx scripts/reverse-test-payout.ts [businessId]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const businessId = process.argv[2] ?? '0ca4c440-5358-4ac6-923c-71317014baf7';
const REASON = 'Reversed test withdrawal by user request — ₦200 restored to wallet';

async function main() {
  // 1. Find the completed payout(s) for this business
  const payouts = await prisma.settlementPayout.findMany({
    where: { businessId, status: 'completed' },
    include: { business: { select: { userId: true } } },
  });

  if (payouts.length === 0) {
    console.log('✅ No completed payouts found for this business — nothing to reverse.');
    return;
  }

  console.log(`Found ${payouts.length} completed payout(s) to reverse:\n`);

  for (const payout of payouts) {
    const amount = Number(payout.amount);
    console.log(`  Payout ${payout.id.slice(0, 8)} — ₦${amount} — ref ${payout.transferReference}`);

    // 2. Transition status inside a transaction with audit + reminder
    await prisma.$transaction(async (tx) => {
      // 2a. Update payout status
      await tx.settlementPayout.update({
        where: { id: payout.id },
        data: {
          status: 'failed',
          failureReason: REASON,
        },
      });

      // 2b. Create audit log entry
      await tx.auditLog.create({
        data: {
          userId: payout.business.userId,
          businessId,
          action: 'settlement.payout_reversed',
          resourceType: 'settlement_payout',
          resourceId: payout.id,
          newData: {
            amount,
            transferReference: payout.transferReference,
            reason: REASON,
          },
        },
      });

      // 2c. Create in-app reminder so the bell notifies the SME
      await tx.reminder.create({
        data: {
          businessId,
          reminderType: 'payout_failed',
          scheduledDate: new Date(),
          isSent: false,
          message: `Your test withdrawal of ₦${amount.toLocaleString('en-NG')} (ref ${payout.transferReference}) has been reversed. The funds have been restored to your wallet balance.`,
          referenceType: 'settlement_payout',
          referenceId: payout.id,
        },
      });
    });

    console.log(`  ✅ Reversed → status: failed, audit logged, reminder created.\n`);
  }

  // 3. Verify final wallet state
  const remaining = await prisma.settlementPayout.aggregate({
    where: { businessId, status: { in: ['completed', 'pending', 'processing'] } },
    _sum: { amount: true },
  });
  const totalActive = Number(remaining._sum.amount ?? 0);
  console.log(`\n── VERIFICATION ──`);
  console.log(`Active withdrawals (completed+pending+processing): ₦${totalActive}`);
  console.log(`Expected: ₦0.00`);
  console.log(totalActive === 0 ? '✅ Wallet balance fully restored!' : '⚠️  Some active payouts remain.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
