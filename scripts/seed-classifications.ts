/**
 * Seed Transaction Classifications
 * Run: npx tsx backend/scripts/seed-classifications.ts
 */

import { PrismaClient } from '@prisma/client';
import { seedTransactionClassifications } from '../prisma/seeds/transaction-classifications';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding transaction classifications...\n');
  
  try {
    await seedTransactionClassifications();
    
    const count = await prisma.transactionClassification.count();
    console.log(`\n✅ Success! ${count} classifications in database`);
    
    const all = await prisma.transactionClassification.findMany({
      select: { name: true, category: true, taxTreatment: true }
    });
    
    console.log('\n📋 Classifications:');
    all.forEach(c => console.log(`  - ${c.name} (${c.category}, ${c.taxTreatment})`));
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
