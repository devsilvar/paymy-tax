const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function verify() {
  console.log('\n🔍 PHASE 0 VERIFICATION\n');
  
  const businesses = await prisma.business.findMany({
    select: {
      businessName: true,
      merchantId: true,
      ownerName: true,
    }
  });
  
  console.log('✅ Businesses in database:');
  businesses.forEach(b => {
    console.log(`   - ${b.businessName} (${b.ownerName})`);
    console.log(`     merchantId: ${b.merchantId || '❌ MISSING'}`);
  });
  
  console.log(`\n✅ Total: ${businesses.length} businesses`);
  console.log(`✅ All have merchantId: ${businesses.every(b => b.merchantId) ? 'YES ✅' : 'NO ❌'}`);
  
  await prisma.$disconnect();
}

verify().catch(console.error);
