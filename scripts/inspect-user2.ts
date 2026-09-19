import prisma from '../src/lib/prisma';
import { toNumber } from '../src/shared/helpers/number';

async function run() {
  const userId2 = 'a6bcaad4-fe43-42e3-88c5-89396f9924e4';
  const user2 = await prisma.user.findUnique({
    where: { id: userId2 },
    include: { businesses: true, walletBalance: true }
  });
  console.log('USER 2:', user2?.email);
  console.log('WALLET 2:', user2?.walletBalance);

  const txs = await prisma.walletTransaction.findMany({
    where: { userId: userId2 },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== ALL TRANSACTIONS FOR USER 2 (yusufsilvajs@gmail.com) ===');
  for (const t of txs) {
    console.log(`[${t.createdAt.toISOString()}] Type: ${t.type.padEnd(6)} | Source: ${t.source.padEnd(10)} | Amt: ${toNumber(t.amount)} | Fee: ${toNumber(t.fee)} | Net: ${toNumber(t.netAmount)} | BalAfter: ${toNumber(t.balanceAfter)} | Ref: ${t.reference} | Desc: ${t.description}`);
  }

  const bizIds = user2?.businesses.map(b => b.id) || [];
  const sales = await prisma.salesTransaction.findMany({
    where: { businessId: { in: bizIds } },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== ALL SALES FOR USER 2 BIZ ===');
  for (const s of sales) {
    console.log(`[${s.createdAt.toISOString()}] ID: ${s.id} | Biz: ${s.businessId} | Source: ${s.source} | Status: ${s.status} | DVA: ${s.dvaOrigin} | Amt: ${toNumber(s.amount)} | Desc: ${s.description} | Ref: ${s.referenceId}`);
  }
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
