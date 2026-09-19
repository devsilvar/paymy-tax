import prisma from '../src/lib/prisma';
import { toNumber } from '../src/shared/helpers/number';

async function run() {
  const p1 = await prisma.settlementPayout.findUnique({
    where: { id: '3610f3e4-1022-488b-81be-ab406df595f0' },
    include: { business: { include: { user: true } } }
  });
  console.log('P1 (1089):', p1?.business?.businessName, '| User:', p1?.business?.user?.email, '| UserID:', p1?.business?.user?.id);

  const p2 = await prisma.settlementPayout.findUnique({
    where: { id: '92f4e831-7188-487f-921c-e5bb77f924fe' },
    include: { business: { include: { user: true } } }
  });
  console.log('P2 (1188):', p2?.business?.businessName, '| User:', p2?.business?.user?.email, '| UserID:', p2?.business?.user?.id);

  const userId = p1?.business?.user?.id;
  if (!userId) {
    console.log('No user found');
    return;
  }

  const allTxs = await prisma.walletTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== ALL TRANSACTIONS FOR THIS USER ===');
  for (const t of allTxs) {
    console.log(`[${t.createdAt.toISOString()}] Type: ${t.type.padEnd(6)} | Source: ${t.source.padEnd(10)} | Amt: ${toNumber(t.amount)} | Fee: ${toNumber(t.fee)} | Net: ${toNumber(t.netAmount)} | BalAfter: ${toNumber(t.balanceAfter)} | Ref: ${t.reference} | Desc: ${t.description}`);
  }

  const wallet = await prisma.walletBalance.findUnique({ where: { userId } });
  console.log('\n=== WALLET BALANCE RECORD ===');
  console.log('Raw:', wallet);

  // Check sales transactions for this user's businesses
  const userBizs = await prisma.business.findMany({ where: { userId }, select: { id: true, businessName: true } });
  const bizIds = userBizs.map(b => b.id);
  const sales = await prisma.salesTransaction.findMany({
    where: { businessId: { in: bizIds } },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== ALL SALES TRANSACTIONS FOR USER BIZ ===');
  for (const s of sales) {
    console.log(`[${s.createdAt.toISOString()}] ID: ${s.id} | Source: ${s.source} | Status: ${s.status} | DVA: ${s.dvaOrigin} | Amt: ${toNumber(s.amount)} | Desc: ${s.description} | Ref: ${s.referenceId}`);
  }
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
