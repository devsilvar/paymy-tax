import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const businessId = process.argv[2] ?? '0ca4c440-5358-4ac6-923c-71317014baf7';

function n(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof (val as any).toNumber === 'function') return (val as any).toNumber();
  const p = Number(val);
  return isNaN(p) ? 0 : p;
}

async function main() {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    console.log('BUSINESS NOT FOUND:', businessId);
    return;
  }
  console.log('── BUSINESS ──');
  console.log('name:', business.businessName);
  console.log('autoSplitEnabled:', business.autoSplitEnabled);
  console.log('taxSplitPercentage:', n(business.taxSplitPercentage));
  console.log('paystackSubaccountCode:', business.paystackSubaccountCode ?? '(none)');

  const sales = await prisma.salesTransaction.findMany({
    where: { businessId },
    orderBy: { transactionDate: 'asc' },
  });
  console.log(`\n── ALL SALES TRANSACTIONS (${sales.length}) ──`);
  for (const s of sales) {
    const meta = s.metadata as any;
    console.log(
      [
        s.id.slice(0, 8),
        `₦${n(s.amount)}`,
        s.source,
        s.status,
        `split=${s.settledViaSplit}`,
        `pct=${s.splitPct ?? '-'}`,
        `retained=${s.platformRetained ?? '-'}`,
        `channel=${meta?.channel ?? '-'}`,
        `needsVerif=${s.needsVerification}`,
        s.transactionDate.toISOString().slice(0, 10),
      ].join(' | ')
    );
  }

  // Exact same aggregates as getPayoutPreview (settlement.service.ts:76-118)
  const dvaWhere = {
    businessId,
    source: 'bank_transfer' as const,
    status: { in: ['confirmed', 'completed'] as any },
    metadata: { path: ['channel'], equals: 'dva' },
  };
  const splitAgg = await prisma.salesTransaction.aggregate({
    where: { ...dvaWhere, settledViaSplit: true },
    _sum: { platformRetained: true, amount: true },
  });
  const plainAgg = await prisma.salesTransaction.aggregate({
    where: { ...dvaWhere, settledViaSplit: false },
    _sum: { amount: true },
  });
  const allAgg = await prisma.salesTransaction.aggregate({
    where: dvaWhere,
    _sum: { amount: true },
  });

  const totalPlatformRetained = n(splitAgg._sum.platformRetained ?? 0);
  const totalPlainInflows = n(plainAgg._sum.amount ?? 0);
  const totalInflowsAll = n(allAgg._sum.amount ?? 0);
  const platformHeldFunds = totalPlainInflows + totalPlatformRetained;

  console.log('\n── PREVIEW MATH (service formula) ──');
  console.log('totalInflowsAll (confirmed DVA):', totalInflowsAll);
  console.log('split-settled retained sum:', totalPlatformRetained, `(gross split inflows: ${n(splitAgg._sum.amount ?? 0)})`);
  console.log('plain inflows sum:', totalPlainInflows);
  console.log('platformHeldFunds:', platformHeldFunds);

  const payouts = await prisma.settlementPayout.findMany({ where: { businessId } });
  console.log(`\n── PAYOUTS (${payouts.length}) ──`);
  for (const p of payouts) {
    console.log(p.id.slice(0, 8), `₦${n(p.amount)}`, p.status, p.createdAt.toISOString());
  }
  const totalWithdrawn = n(
    payouts.filter((p) => ['completed', 'pending', 'processing'].includes(p.status)).reduce((a, p) => a + n(p.amount), 0)
  );
  console.log('totalWithdrawn (completed+pending+processing):', totalWithdrawn);

  const unpaidReports = await prisma.monthlyTaxReport.findMany({
    where: { businessId, paymentStatus: { in: ['pending', 'failed'] } },
  });
  console.log(`\n── UNPAID TAX REPORTS (${unpaidReports.length}) ──`);
  for (const r of unpaidReports) {
    console.log(r.taxMonth, `taxPayable=₦${n(r.taxPayable)}`, r.paymentStatus);
  }
  let estimatedTaxLiability = unpaidReports.reduce((a, r) => a + n(r.taxPayable), 0);

  const totalInflowsCount = await prisma.salesTransaction.count({ where: dvaWhere });
  if (unpaidReports.length === 0 && totalInflowsAll > 0) {
    const expAgg = await prisma.expense.aggregate({
      where: { businessId, isDeductible: true },
      _sum: { amount: true },
    });
    const totalExpenses = n(expAgg._sum.amount ?? 0);
    const grossProfit = Math.max(0, totalInflowsAll - totalExpenses);
    estimatedTaxLiability = Math.round(grossProfit * 0.075 * 100) / 100;
    console.log('\n── FALLBACK ESTIMATE ──');
    console.log('deductible expenses:', totalExpenses);
    console.log('grossProfit:', grossProfit);
    console.log('estimate 7.5%:', estimatedTaxLiability);
  }

  const taxReserve = Math.max(0, estimatedTaxLiability);
  // Matches production Option A: tax due is display-only, not subtracted.
  const availableForWithdrawal = Math.max(0, Math.round((platformHeldFunds - totalWithdrawn) * 100) / 100);
  console.log('\n── RESULT ──');
  console.log('taxReserve:', taxReserve);
  console.log('availableForWithdrawal:', availableForWithdrawal);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());