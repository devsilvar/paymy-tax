import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const all = await prisma.transactionClassification.findMany({
    orderBy: { name: 'asc' }
  });
  
  const active = all.filter(c => c.isActive);
  
  console.log(`Total: ${all.length}, Active: ${active.length}\n`);
  
  console.log('All classifications:');
  all.forEach((c, i) => {
    console.log(`${i + 1}. ${c.name} - ${c.category} - Active: ${c.isActive}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
