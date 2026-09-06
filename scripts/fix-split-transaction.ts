/**
 * Fix Split Transaction Script
 *
 * Converts auto-split transactions (`settledViaSplit: true`) to plain platform
 * inflows (`settledViaSplit: false`, `platformRetained: null`, `splitPct: null`).
 * Restores the full ₦1,100 balance to the platform-held wallet for the business.
 * Creates an audit log entry for compliance.
 *
 * Usage:
 *   npx tsx scripts/fix-split-transaction.ts [businessId]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const businessId = process.argv[2] ?? '0ca4c440-5358-4ac6-923c-71317014baf7';

async function main() {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, userId: true, businessName: true },
  });

  if (!business) {
    console.error(`❌ Business with ID ${businessId} not found.`);
    return;
  }

  console.log(`Auditing business: ${business.businessName} (${business.id})`);

  // 1. Find all split transactions for this business
  const splitTransactions = await prisma.salesTransaction.findMany({
    where: {
      businessId,
      settledViaSplit: true,
    },
    select: {
      id: true,
      amount: true,
      platformRetained: true,
      referenceId: true,
    },
  });

  if (splitTransactions.length === 0) {
    console.log('✅ No split-settled transactions found for this business.');
    return;
  }

  console.log(`Found ${splitTransactions.length} split-settled transaction(s):`);
  for (const tx of splitTransactions) {
    console.log(`  Tx ${tx.id.slice(0, 8)}: Amount ₦${Number(tx.amount)}, Retained ₦${Number(tx.platformRetained)}, Ref ${tx.referenceId}`);
  }

  // 2. Perform atomic conversion with audit log
  await prisma.$transaction(async (tx) => {
    const updated = await tx.salesTransaction.updateMany({
      where: {
        businessId,
        settledViaSplit: true,
      },
      data: {
        settledViaSplit: false,
        platformRetained: null,
        splitPct: null,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: business.userId,
        businessId,
        action: 'sale.reclassified_split_to_plain',
        resourceType: 'sales_transaction',
        newData: {
          affectedCount: updated.count,
          transactionIds: splitTransactions.map((t) => t.id),
          reason: 'Reclassified test auto-split transaction to plain inflow to restore full wallet balance',
        },
      },
    });

    console.log(`\n✅ Converted ${updated.count} transaction(s) to plain inflows. Audit log written.`);
  });
}

main()
  .catch((err) => {
    console.error('Error executing script:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
