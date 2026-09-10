/* FULL data wipe — deliberately destructive, for clean-slate restores.
 * Wipes ALL business data (keeps reference data: classifications, banks,
 * webhook event log, and the migrations table). Then run db-restore.ts.
 *
 * Guarded: requires ALLOW_TEST_DB_WIPE=true, same contract as test-db.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

function envUrlFromDotenv(name: string): string | undefined {
  const envPath = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs
    .readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(name + '='));
  return line ? line.split('=').slice(1).join('=').trim() : undefined;
}
const directUrl = envUrlFromDotenv('DIRECT_URL');
const prisma = new PrismaClient({
  datasources: { db: { url: directUrl ?? process.env.DATABASE_URL } },
});

async function main() {
  if (process.env.ALLOW_TEST_DB_WIPE !== 'true') {
    console.error(
      'REFUSING TO WIPE. This deletes ALL business data. Re-run with ALLOW_TEST_DB_WIPE=true if you are certain.'
    );
    process.exit(1);
  }

  // Dependency-safe order. Keeps: transaction_classifications, banks,
  // paystack_webhook_events (append-only logs), _prisma_migrations.
  const steps: Array<[string, string]> = [
    ['wallet_transactions', `DELETE FROM wallet_transactions`],
    ['wallet_balances', `DELETE FROM wallet_balances`],
    ['settlement_payouts', `DELETE FROM settlement_payouts`],
    ['sessions', `DELETE FROM sessions`],
    ['reminders', `DELETE FROM reminders`],
    ['invoice_lines', `DELETE FROM invoice_lines`],
    ['invoices', `DELETE FROM invoices`],
    ['customers', `DELETE FROM customers`],
    ['tax_statements', `DELETE FROM tax_statements`],
    ['tax_payments', `DELETE FROM tax_payments`],
    ['firs_remittances', `DELETE FROM firs_remittances`],
    ['monthly_tax_reports', `DELETE FROM monthly_tax_reports`],
    ['sale_line_items', `DELETE FROM sale_line_items`],
    ['sales_transactions', `DELETE FROM sales_transactions`],
    ['expenses', `DELETE FROM expenses`],
    ['businesses', `DELETE FROM businesses`],
    ['audit_logs', `DELETE FROM audit_logs`],
    ['users', `DELETE FROM users`],
  ];

  for (const [table, sql] of steps) {
    const n = (await prisma.$executeRawUnsafe(sql)) as number;
    console.log(`  wiped ${table}: ${n} rows`);
  }
  console.log('Full data wipe complete. Now run: npm run db:restore');
}

main()
  .catch((e) => {
    console.error('FATAL:', (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
