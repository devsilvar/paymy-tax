/* One-off: diff live transaction_classifications vs backup — read-only. */
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
  const backup = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../backups/latest-backup.json'), 'utf-8')
  );
  const backupRows = backup.data.transactionClassifications as Array<Record<string, unknown>>;

  const liveRows = (await prisma.$queryRawUnsafe(
    `SELECT id, name, category, tax_treatment, is_revenue, is_expense, description, is_active
     FROM transaction_classifications ORDER BY name`
  )) as Array<Record<string, unknown>>;

  console.log('=== BACKUP classifications ===');
  for (const r of backupRows)
    console.log(
      `  ${r.id}  ${r.name}  cat=${r.category}  treat=${r.taxTreatment}  rev=${r.isRevenue} exp=${r.isExpense}`
    );

  console.log('=== LIVE classifications ===');
  for (const r of liveRows)
    console.log(
      `  ${r.id}  ${r.name}  cat=${r.category}  treat=${r.tax_treatment}  rev=${r.is_revenue} exp=${r.is_expense}`
    );

  // Compare by name on the meaningful fields
  const norm = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const backupByName = new Map(
    backupRows.map((r) => [
      r.name,
      {
        category: norm(r.category),
        taxTreatment: norm(r.taxTreatment),
        isRevenue: Boolean(r.isRevenue),
        isExpense: Boolean(r.isExpense),
        description: norm(r.description),
        isActive: Boolean(r.isActive),
      },
    ])
  );
  console.log('=== field-level diff (by name) ===');
  for (const r of liveRows) {
    const b = backupByName.get(String(r.name));
    if (!b) {
      console.log(`  LIVE-ONLY (not in backup): ${r.name}`);
      continue;
    }
    const live = {
      category: norm(r.category),
      taxTreatment: norm(r.tax_treatment),
      isRevenue: Boolean(r.is_revenue),
      isExpense: Boolean(r.is_expense),
      description: norm(r.description),
      isActive: Boolean(r.is_active),
    };
    const same = JSON.stringify(live) === JSON.stringify(b);
    console.log(`  ${r.name}: ${same ? 'IDENTICAL' : '*** DIFFERS ***'}`);
    if (!same) {
      console.log('    backup:', JSON.stringify(b));
      console.log('    live:  ', JSON.stringify(live));
    }
  }
  for (const [name] of backupByName) {
    if (!liveRows.some((r) => r.name === name))
      console.log(`  BACKUP-ONLY (not live): ${name}`);
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
