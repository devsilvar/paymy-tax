/* One-off fix: replace re-seeded classifications with backup originals.
   Safe ONLY while nothing references the live rows (sales_transactions empty). */
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
  // Safety gate: refuse to run if any live sales reference classifications.
  const refs = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM sales_transactions WHERE classification_id IS NOT NULL`
  )) as Array<{ c: number }>;
  if (refs[0].c > 0) {
    console.error(
      `ABORT: ${refs[0].c} sales transactions reference classifications — remap required, deletion unsafe.`
    );
    process.exit(1);
  }

  const backup = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../backups/latest-backup.json'), 'utf-8')
  );
  const backupRows = backup.data.transactionClassifications as Array<Record<string, unknown>>;
  console.log(`Backup has ${backupRows.length} classifications.`);

  // Verify no live classification name is missing from backup before deleting
  const live = (await prisma.$queryRawUnsafe(
    `SELECT name FROM transaction_classifications`
  )) as Array<{ name: string }>;
  const backupNames = new Set(backupRows.map((r) => String(r.name)));
  const liveOnly = live.filter((r) => !backupNames.has(r.name));
  if (liveOnly.length > 0) {
    console.error(`ABORT: live-only classifications would be lost: ${liveOnly.map((r) => r.name)}`);
    process.exit(1);
  }

  const deleted = (await prisma.$executeRawUnsafe(
    `DELETE FROM transaction_classifications`
  )) as number;
  console.log(`Deleted ${deleted} live (re-seeded) classification rows.`);

  await prisma.transactionClassification.createMany({ data: backupRows as any });
  console.log(`Restored ${backupRows.length} original classification rows (original IDs).`);
}

main()
  .catch((e) => {
    console.error('FATAL:', (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
