/* One-off: verify restore + simulate login against restored hashes. */
import * as fs from 'fs';
import * as path from 'path';
import bcrypt from 'bcrypt';
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
  const counts = (await prisma.$queryRawUnsafe(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM businesses) AS businesses,
            (SELECT COUNT(*)::int FROM sales_transactions) AS sales,
            (SELECT COUNT(*)::int FROM expenses) AS expenses,
            (SELECT COUNT(*)::int FROM audit_logs) AS audit_logs,
            (SELECT COUNT(*)::int FROM reminders) AS reminders,
            (SELECT COUNT(*)::int FROM sessions) AS sessions`
  )) as Array<Record<string, number>>;
  console.log('=== post-restore counts ===');
  console.log(JSON.stringify(counts[0]));

  // Simulate the exact login flow: find by email -> isActive -> bcrypt.compare
  const candidates: Array<[string, string]> = [
    ['admin@paymytax.com', 'Admin@123456'],
    ['john@example.com', 'Password123!'],
  ];
  console.log('=== login simulation (find by email -> isActive -> bcrypt) ===');
  for (const [email, password] of candidates) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log(`  ${email}: NOT FOUND in DB`);
      continue;
    }
    if (!user.isActive) {
      console.log(`  ${email}: found but isActive=false (would get ACCOUNT_DEACTIVATED)`);
      continue;
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    console.log(
      `  ${email}: found, active, password "${password}" -> ${match ? 'LOGIN OK ✅' : 'WRONG PASSWORD ❌'}`
    );
  }

  // List all restored emails so the user knows which accounts exist
  const users = await prisma.user.findMany({
    select: { email: true, role: true, isActive: true, lastLoginAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('=== restored accounts ===');
  for (const u of users)
    console.log(
      `  ${u.email}  role=${u.role}  active=${u.isActive}  lastLogin=${u.lastLoginAt?.toISOString() ?? 'never'}`
    );
}

main()
  .catch((e) => {
    console.error('FATAL:', (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
