/**
 * Backfill script for sales verification columns.
 * 
 * Marks all existing bank_transfer sales as verified (grandfather clause).
 * Only new transfers (after this migration) will require owner verification.
 * 
 * Run once after the add_sales_verification migration:
 * npx tsx scripts/backfill-sales-verification.ts
 */

import prisma from '../src/lib/prisma';
import logger from '../src/lib/logger';

async function backfillSalesVerification() {
  try {
    logger.info('Starting sales verification backfill...');

    const result = await prisma.salesTransaction.updateMany({
      where: {
        source: 'bank_transfer',
        needsVerification: false, // not yet set by migration default
      },
      data: {
        needsVerification: false,
        verifiedAt: new Date(),
        finalClassification: 'sale',
        isTaxable: true,
      },
    });

    logger.info(`Backfill complete: ${result.count} transactions marked as verified`);

    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    logger.error('Backfill failed', { error });
    await prisma.$disconnect();
    process.exit(1);
  }
}

backfillSalesVerification();
