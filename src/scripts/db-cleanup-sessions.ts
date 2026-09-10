/* One-off cleanup: delete sessions whose user no longer exists. */
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
  const deleted = (await prisma.$executeRawUnsafe(
    `DELETE FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)`
  )) as number;
  console.log('deleted orphaned sessions:', deleted);
  const left = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM sessions`
  )) as Array<{ c: number }>;
  console.log('sessions remaining:', left[0].c);

  // Final integrity sweep: any FK-style orphans left across key relations?
  const checks = [
    ['businesses -> users', `SELECT COUNT(*)::int AS c FROM businesses b LEFT JOIN users u ON u.id=b.user_id WHERE u.id IS NULL`],
    ['sales -> businesses', `SELECT COUNT(*)::int AS c FROM sales_transactions s LEFT JOIN businesses b ON b.id=s.business_id WHERE b.id IS NULL`],
    ['sales -> classifications', `SELECT COUNT(*)::int AS c FROM sales_transactions s LEFT JOIN transaction_classifications c ON c.id=s.classification_id WHERE s.classification_id IS NOT NULL AND c.id IS NULL`],
    ['expenses -> businesses', `SELECT COUNT(*)::int AS c FROM expenses e LEFT JOIN businesses b ON b.id=e.business_id WHERE b.id IS NULL`],
    ['invoice_lines -> invoices', `SELECT COUNT(*)::int AS c FROM invoice_lines l LEFT JOIN invoices i ON i.id=l.invoice_id WHERE i.id IS NULL`],
    ['tax_payments -> reports', `SELECT COUNT(*)::int AS c FROM tax_payments p LEFT JOIN monthly_tax_reports r ON r.id=p.tax_report_id WHERE p.tax_report_id IS NOT NULL AND r.id IS NULL`],
    ['reminders -> businesses', `SELECT COUNT(*)::int AS c FROM reminders r LEFT JOIN businesses b ON b.id=r.business_id WHERE b.id IS NULL`],
  ] as Array<[string, string]>;
  for (const [label, sql] of checks) {
    const r = (await prisma.$queryRawUnsafe(sql)) as Array<{ c: number }>;
    console.log(`${label}: ${r[0].c === 0 ? 'OK (0 orphans)' : '*** ' + r[0].c + ' ORPHANS ***'}`);
  }
}

main()
  .catch((e) => {
    console.error('FATAL:', (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
