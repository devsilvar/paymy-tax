/**
 * Test Script: Create Unverified Transaction
 * Run: npx tsx backend/scripts/test-unverified.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧪 Testing Unverified Transactions...\n');

  // Step 1: Check classifications
  const classifications = await prisma.transactionClassification.findMany({
    where: { isActive: true }
  });
  console.log(`✅ Found ${classifications.length} active classifications`);
  
  if (classifications.length === 0) {
    console.log('❌ No classifications! Run: npm run prisma:seed');
    process.exit(1);
  }

  // Step 2: Get first business
  const business = await prisma.business.findFirst({
    include: { user: { select: { email: true } } }
  });
  
  if (!business) {
    console.log('❌ No business found! Create a business first.');
    process.exit(1);
  }
  
  console.log(`✅ Using business: ${business.name} (${business.merchantId})`);
  console.log(`   Owner: ${business.user.email}\n`);

  // Step 3: Create test unverified transaction
  const amount = Math.floor(Math.random() * 50000) + 10000;
  
  const sale = await prisma.salesTransaction.create({
    data: {
      businessId: business.id,
      amount,
      source: 'bank_transfer',
      status: 'pending',
      referenceId: `TEST_${Date.now()}`,
      customerName: 'Test Customer',
      customerHint: 'Test payment via bank transfer',
      transactionDate: new Date(),
      needsVerification: true,
      isTaxable: true,
      metadata: {
        test: true,
        autoRecorded: true,
      }
    }
  });

  console.log(`✅ Created test transaction:`);
  console.log(`   Amount: ₦${amount.toLocaleString()}`);
  console.log(`   ID: ${sale.id}`);
  console.log(`   Needs Verification: ${sale.needsVerification}\n`);

  // Step 4: Check unverified count
  const unverifiedCount = await prisma.salesTransaction.count({
    where: { businessId: business.id, needsVerification: true }
  });

  console.log(`✅ Total unverified transactions: ${unverifiedCount}\n`);

  // Step 5: List all unverified
  const unverified = await prisma.salesTransaction.findMany({
    where: { businessId: business.id, needsVerification: true },
    take: 5,
    orderBy: { transactionDate: 'desc' }
  });

  console.log('📋 Recent unverified transactions:');
  unverified.forEach(tx => {
    console.log(`   - ₦${tx.amount.toLocaleString()} from ${tx.customerName} (${tx.transactionDate.toLocaleDateString()})`);
  });

  console.log('\n✅ Setup complete!');
  console.log('\n📝 Next steps:');
  console.log('   1. Login to frontend as:', business.user.email);
  console.log('   2. Go to Unverified Transactions tab');
  console.log(`   3. You should see ${unverifiedCount} transaction(s)`);
  console.log('   4. Click "Verify Transaction"');
  console.log(`   5. Modal should show ${classifications.length} classification options`);
  console.log('\n💡 Classification options available:');
  classifications.slice(0, 5).forEach(c => {
    console.log(`   - ${c.name} (${c.category})`);
  });
  if (classifications.length > 5) {
    console.log(`   ... and ${classifications.length - 5} more`);
  }
}

main()
  .catch(e => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
