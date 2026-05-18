import prisma from '../src/lib/prisma';

async function main() {
  const businesses = await prisma.business.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nFound ${businesses.length} business(es):\n`);
  for (const b of businesses) {
    console.log(`- ${b.businessName} (id=${b.id})`);
    console.log(`    owner: ${b.user.email}`);
    console.log(`    merchantId: ${b.merchantId}`);
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
