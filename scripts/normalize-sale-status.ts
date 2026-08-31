/**
 * Normalize SalesTransaction statuses.
 *
 * Standardizes every settled sale onto the canonical 'confirmed' status:
 *   completed → confirmed   (legacy manual-entry/import/invoice-paid rows)
 *
 * pending / reversed / disputed rows are intentionally LEFT ALONE — they are
 * real workflow states (unverified DVA inflows, refunds), not settled sales.
 *
 * Idempotent: running it twice is a no-op the second time.
 *
 * Usage:  cd backend && npx tsx scripts/normalize-sale-status.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const before = await prisma.salesTransaction.groupBy({
    by: ['status'],
    _count: true,
  });

  console.log('=== Before normalization ===');
  for (const row of before) console.log(`  ${row.status}: ${row._count}`);

  const result = await prisma.salesTransaction.updateMany({
    where: { status: 'completed' },
    data: { status: 'confirmed' },
  });

  console.log(`\nMigrated ${result.count} row(s) from 'completed' → 'confirmed'.`);

  const after = await prisma.salesTransaction.groupBy({
    by: ['status'],
    _count: true,
  });

  console.log('\n=== After normalization ===');
  for (const row of after) console.log(`  ${row.status}: ${row._count}`);

  const settled = await prisma.salesTransaction.count({
    where: { status: { in: ['confirmed', 'completed'] } },
  });
  console.log(`\nSettled sales now visible to tax/dashboard/summary: ${settled}`);
}

main()
  .catch((err) => {
    console.error('Normalization failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
