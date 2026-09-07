import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const payouts = await prisma.settlementPayout.findMany({
    include: { business: { select: { businessName: true, userId: true } } },
  });
  console.log('PAYOUTS_COUNT:', payouts.length);
  console.log('ALL_PAYOUTS:', JSON.stringify(payouts, null, 2));

  const businesses = await prisma.business.findMany({
    select: {
      id: true,
      businessName: true,
      userId: true,
      sales: {
        where: { metadata: { path: ['channel'], equals: 'dva' } },
        select: { id: true, amount: true, status: true, settledViaSplit: true, platformRetained: true },
      },
    },
  });
  console.log('BIZ_SALES:', JSON.stringify(businesses, null, 2));
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
