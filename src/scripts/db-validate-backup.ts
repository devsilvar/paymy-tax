/* One-off backup integrity validator — read-only, touches nothing. */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

// Prefer the direct (session-mode, port 5432) connection for diagnostics —
// the transaction-mode pooler on 6543 can hang under cold start.
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
  // 1. Parse + validate the backup JSON
  const backupPath = path.resolve(__dirname, '../../backups/latest-backup.json');
  const raw = fs.readFileSync(backupPath, 'utf-8');
  const backup = JSON.parse(raw);

  console.log('=== backup metadata ===');
  console.log(JSON.stringify(backup.metadata, null, 2));

  console.log('=== actual per-collection counts ===');
  const expected: Record<string, number> = backup.metadata.recordCounts;
  for (const [key, rows] of Object.entries(backup.data)) {
    const count = Array.isArray(rows) ? rows.length : -1;
    const metaCount = expected[key];
    const flag =
      metaCount === undefined ? '(not in metadata)' : metaCount === count ? 'OK' : '*** MISMATCH ***';
    console.log(`  ${key}: ${count}  ${flag}`);
  }

  // 2. Check live FK state on sessions + orphan sessions
  const fks = (await prisma.$queryRawUnsafe(
    `SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'sessions'::regclass AND contype = 'f'`
  )) as Array<{ conname: string; confdeltype: string }>;
  console.log('=== sessions FK constraints (confdeltype: c=cascade, a=no action) ===');
  console.log(JSON.stringify(fks));

  const orphanSessions = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL`
  )) as Array<{ c: number }>;
  console.log('=== orphaned sessions (user_id with no matching user) ===');
  console.log(JSON.stringify(orphanSessions));

  // 3. Sanity: backup user emails + business ids (dedup check)
  const emails = backup.data.users.map((u: { email: string }) => u.email);
  console.log('=== backup user emails ===');
  console.log(JSON.stringify(emails, null, 1));
  const dupEmails = emails.filter(
    (e: string, i: number) => emails.indexOf(e) !== i
  );
  console.log('duplicate emails in backup:', JSON.stringify(dupEmails));

  const bizIds = backup.data.businesses.map((b: { id: string }) => b.id);
  const dupBiz = bizIds.filter((b: string, i: number) => bizIds.indexOf(b) !== i);
  console.log('duplicate business ids in backup:', JSON.stringify(dupBiz));
}

main()
  .catch((e) => {
    console.error('FATAL:', (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
