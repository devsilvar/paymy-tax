import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// READ-ONLY: counts only. No writes, no deletes.
// Uses connection_limit=1 so it never fights the app for pooled connections.
function makeClient(): PrismaClient {
  const base = process.env.DATABASE_URL!;
  const sep = base.includes('?') ? '&' : '?';
  return new PrismaClient({
    datasources: { db: { url: `${base}${sep}connection_limit=1&pool_timeout=20` } },
  });
}

async function main() {
  const p = makeClient();
  const counts: Record<string, number> = {};
  // Sequential — each query opens/uses one connection at a time
  counts.users = await p.user.count();
  counts.businesses = await p.business.count();
  counts.sales = await p.salesTransaction.count();
  counts.expenses = await p.expense.count();
  counts.reports = await p.monthlyTaxReport.count();
  counts.invoices = await p.invoice.count();
  counts.payouts = await p.settlementPayout.count();
  counts.reminders = await p.reminder.count();
  console.log('=== READ-ONLY DB CHECK (counts only, nothing modified) ===');
  console.log(JSON.stringify(counts, null, 2));

  // Show each user with their businesses so you can see nothing is missing per-user
  const rows = await p.user.findMany({
    select: { email: true, role: true, createdAt: true, businesses: { select: { businessName: true, merchantId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('\n=== USERS AND THEIR BUSINESSES ===');
  for (const r of rows) {
    console.log(`- ${r.email} (${r.role}, joined ${r.createdAt.toISOString().slice(0, 10)}) -> ${r.businesses.length} business(es): ${r.businesses.map((b) => `${b.businessName} [${b.merchantId}]`).join(', ') || '(none)'}`);
  }
  await p.$disconnect();
}

main().catch((e) => {
  console.error('DB healthcheck failed:', e.message);
  process.exit(1);
});


