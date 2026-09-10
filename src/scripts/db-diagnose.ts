/* One-off DB state diagnostic — read-only, touches nothing. */
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
if (directUrl) {
  process.env.DATABASE_URL = directUrl;
  console.log('(using DIRECT_URL for diagnostics)');
}

const prisma = new PrismaClient({
  datasources: { db: { url: directUrl ?? process.env.DATABASE_URL } },
});


async function main() {
  // 1. Which migrations does the live DB think it has applied?
  try {
    const m = (await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name'
    )) as Array<{ migration_name: string; finished_at: Date | null }>;
    console.log('=== _prisma_migrations (' + m.length + ') ===');
    for (const row of m) console.log('  ' + row.migration_name + '  finished=' + row.finished_at);
  } catch (e) {
    console.log('!!! _prisma_migrations query failed:', (e as Error).message);
  }

  // 2. What tables exist?
  const tables = (await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
  )) as Array<{ table_name: string }>;
  console.log('=== tables in public schema (' + tables.length + ') ===');
  for (const t of tables) console.log('  ' + t.table_name);

  // 3. Row counts per table
  console.log('=== row counts ===');
  for (const t of tables) {
    if (t.table_name === '_prisma_migrations') continue;
    try {
      const r = (await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS c FROM "${t.table_name}"`
      )) as Array<{ c: number }>;
      console.log(`  ${t.table_name}: ${r[0].c}`);
    } catch (e) {
      console.log(`  ${t.table_name}: ERROR ${(e as Error).message}`);
    }
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
