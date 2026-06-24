import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const classifications = await prisma.transactionClassification.findMany({
    where: { isActive: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  
  console.log(`\n✅ API returns ${classifications.length} classifications\n`);
  
  // Group by category
  const byCategory: Record<string, any[]> = {};
  classifications.forEach(c => {
    if (!byCategory[c.category]) byCategory[c.category] = [];
    byCategory[c.category].push(c);
  });
  
  Object.entries(byCategory).forEach(([category, items]) => {
    console.log(`\n${category.toUpperCase()} (${items.length}):`);
    items.forEach(item => {
      console.log(`  - ${item.name} (${item.taxTreatment})`);
    });
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
