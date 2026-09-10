import { PrismaClient } from '@prisma/client';

/**
 * Tests use TEST_DATABASE_URL when provided, so a dedicated test database can
 * be used instead of the live one. Set it in .env to make integration tests
 * structurally incapable of touching production data:
 *   TEST_DATABASE_URL=postgresql://.../postgres  (a SEPARATE Supabase project/branch)
 */
export const testDb = new PrismaClient(
  process.env.TEST_DATABASE_URL
    ? { datasources: { db: { url: process.env.TEST_DATABASE_URL } } }
    : undefined
);

/**
 * SAFETY GUARD — clearDatabase() wipes every business table, and jest loads
 * the real `.env`, so without TEST_DATABASE_URL these tests run against the
 * LIVE Supabase database. This already destroyed production data THREE times
 * (Sept 2026).
 *
 * The wipe is refused unless:
 *   - TEST_DATABASE_URL is set (dedicated test DB — always safe), or
 *   - the database name clearly contains "test", or
 *   - the operator explicitly opts in PER RUN:
 *       bash:        ALLOW_TEST_DB_WIPE=true npx jest ...
 *       PowerShell:  $env:ALLOW_TEST_DB_WIPE='true'; npx jest ...; Remove-Item Env:ALLOW_TEST_DB_WIPE
 *
 * ⚠️ PowerShell footgun: $env: vars PERSIST FOR THE WHOLE TERMINAL SESSION.
 * Always unset it immediately after the run (see the Remove-Item above), or
 * every later jest run in that window will keep wiping the live DB.
 */
export async function clearDatabase() {
  const effectiveUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  const dbName = effectiveUrl.split('/')[3]?.split('?')[0] ?? '';
  const usesDedicatedTestDb = Boolean(process.env.TEST_DATABASE_URL);
  const isTestDb = /test/i.test(dbName);
  const explicitlyAllowed = process.env.ALLOW_TEST_DB_WIPE === 'true';

  if (!usesDedicatedTestDb && !isTestDb && !explicitlyAllowed) {
    throw new Error(
      `REFUSING TO WIPE: target database "${dbName}" does not look like a test database.\n` +
        `This wiped live production data three times already. Options:\n` +
        `  1. (best) Set TEST_DATABASE_URL in .env to a dedicated test database.\n` +
        `  2. Re-run with ALLOW_TEST_DB_WIPE=true to deliberately wipe "${dbName}".\n` +
        `     In PowerShell, ALWAYS unset it right after: Remove-Item Env:ALLOW_TEST_DB_WIPE`
    );
  }

  // Clear in correct order (respecting foreign keys)
  await testDb.walletTransaction.deleteMany();
  await testDb.walletBalance.deleteMany();
  await testDb.settlementPayout.deleteMany();
  await testDb.salesTransaction.deleteMany();
  await testDb.expense.deleteMany();
  await testDb.monthlyTaxReport.deleteMany();
  await testDb.taxPayment.deleteMany();
  await testDb.customer.deleteMany();
  await testDb.invoice.deleteMany();
  await testDb.business.deleteMany();
  await testDb.auditLog.deleteMany();
  await testDb.user.deleteMany();
}

export async function createTestUser(email?: string) {
  return testDb.user.create({
    data: {
      email: email || `test-${Date.now()}@example.com`,
      passwordHash: '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyJSawHByQBW', // hashed "password"
      isVerified: true,
      isActive: true,
    },
  });
}

export async function createTestBusiness(userId: string, name?: string) {
  const count = await testDb.business.count();
  return testDb.business.create({
    data: {
      userId,
      merchantId: `TEST${String(count + 1).padStart(4, '0')}`,
      businessName: name || `Test Business ${count + 1}`,
      ownerName: 'Test Owner',
      taxId: `TAX-${Date.now()}-${count}`,
      businessType: 'Retail',
    },
  });
}
