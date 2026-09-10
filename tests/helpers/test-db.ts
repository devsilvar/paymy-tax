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
 * DYNAMIC BASELINE PROTECTION:
 * Automatically captures existing database user and business IDs when tests start.
 * Any account already present in the database before the test run is dynamically
 * protected and will NEVER be deleted by tests or cleanup scripts.
 */
export const baselineUserIds = new Set<string>();
export const baselineBusinessIds = new Set<string>();
let hasCapturedBaseline = false;

/**
 * Capture pre-existing user and business IDs so we never touch real accounts,
 * regardless of who registers in the database.
 */
async function captureBaseline() {
  if (hasCapturedBaseline) return;
  try {
    const existingUsers = await testDb.user.findMany({ select: { id: true } });
    for (const u of existingUsers) baselineUserIds.add(u.id);

    const existingBusinesses = await testDb.business.findMany({ select: { id: true } });
    for (const b of existingBusinesses) baselineBusinessIds.add(b.id);

    hasCapturedBaseline = true;
  } catch (err) {
    // If DB is unreachable yet, continue; it will be captured on next call
  }
}

/**
 * Tracks test users and businesses created dynamically during test runs
 * so cleanup can be targeted with surgical precision without touching
 * any real users or data.
 */
export const createdUserIds = new Set<string>();
export const createdBusinessIds = new Set<string>();

/**
 * PERMANENT HARD SAFETY GUARD — Scoped Database Cleanup
 *
 * 1. Automatically captures and protects all baseline accounts in the database.
 * 2. Only deletes records explicitly created by tests (tracked in createdUserIds
 *    and createdBusinessIds, or matching explicit test prefixes like 'test-*'
 *    or 'qa-hunter-*').
 * 3. Never deletes real users or businesses, dynamically protecting newly
 *    registered users without needing any hardcoded email lists.
 * 4. Full table wiping is REFUSED unless:
 *      - ALLOW_FULL_TABLE_WIPE='true' is set, AND
 *      - PREVENT_DB_WIPE is NOT set, AND
 *      - Database name explicitly contains 'test'.
 */
export async function clearDatabase() {
  await captureBaseline();

  const effectiveUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  const dbName = effectiveUrl.split('/')[3]?.split('?')[0] ?? '';
  const isDedicatedTestName = /test/i.test(dbName);
  const allowFullWipe =
    process.env.ALLOW_FULL_TABLE_WIPE === 'true' &&
    process.env.PREVENT_DB_WIPE !== 'true' &&
    isDedicatedTestName;

  if (allowFullWipe) {
    // eslint-disable-next-line no-console
    console.log(`🧹 Full table wipe explicitly authorized on dedicated test database "${dbName}".`);
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
    return;
  }

  // ─── SCOPED CLEANUP (SAFE FOR SHARED & LIVE DATABASES) ────────────────────────
  // Collect all test-generated IDs to remove:
  const userIdsToDelete = new Set<string>(createdUserIds);
  const businessIdsToDelete = new Set<string>(createdBusinessIds);

  try {
    // Find any test users created by test runs matching explicit test prefixes,
    // ensuring we NEVER touch any user that was part of the pre-existing baseline
    const testUsers = await testDb.user.findMany({
      where: {
        AND: [
          {
            OR: [
              { email: { startsWith: 'test-' } },
              { email: { startsWith: 'qa-hunter-' } },
              { email: { contains: '@e2e.com' } },
            ],
          },
          ...(baselineUserIds.size > 0
            ? [{ id: { notIn: Array.from(baselineUserIds) } }]
            : []),
        ],
      },
      select: { id: true },
    });
    for (const u of testUsers) userIdsToDelete.add(u.id);

    // Find any test businesses matching test prefixes or owned by test users,
    // ensuring baseline businesses are never touched
    const testBusinesses = await testDb.business.findMany({
      where: {
        AND: [
          {
            OR: [
              { merchantId: { startsWith: 'TEST' } },
              { businessName: { startsWith: 'QA Hunter' } },
              { businessName: { startsWith: 'Test Business' } },
              { userId: { in: Array.from(userIdsToDelete) } },
            ],
          },
          ...(baselineBusinessIds.size > 0
            ? [{ id: { notIn: Array.from(baselineBusinessIds) } }]
            : []),
        ],
      },
      select: { id: true },
    });
    for (const b of testBusinesses) businessIdsToDelete.add(b.id);

    const targetUserIds = Array.from(userIdsToDelete);
    const targetBusinessIds = Array.from(businessIdsToDelete);

    if (targetUserIds.length === 0 && targetBusinessIds.length === 0) {
      return; // Nothing to clean up
    }

    // Delete child records first to respect foreign key constraints
    await testDb.walletTransaction.deleteMany({
      where: {
        OR: [
          { businessId: { in: targetBusinessIds } },
          { userId: { in: targetUserIds } },
        ],
      },
    });

    await testDb.walletBalance.deleteMany({
      where: { userId: { in: targetUserIds } },
    });

    await testDb.settlementPayout.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.saleLineItem.deleteMany({
      where: {
        sale: { businessId: { in: targetBusinessIds } },
      },
    });

    await testDb.salesTransaction.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.expense.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.taxStatement.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.taxPayment.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.monthlyTaxReport.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.invoiceLine.deleteMany({
      where: {
        invoice: { businessId: { in: targetBusinessIds } },
      },
    });

    await testDb.invoice.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.customer.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.reminder.deleteMany({
      where: { businessId: { in: targetBusinessIds } },
    });

    await testDb.auditLog.deleteMany({
      where: {
        OR: [
          { businessId: { in: targetBusinessIds } },
          { userId: { in: targetUserIds } },
        ],
      },
    });

    await testDb.business.deleteMany({
      where: { id: { in: targetBusinessIds } },
    });

    await testDb.user.deleteMany({
      where: { id: { in: targetUserIds } },
    });

    // Clear tracked sets after cleanup
    createdUserIds.clear();
    createdBusinessIds.clear();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Scoped cleanup encountered an error (continuing):', err);
  }
}

export async function createTestUser(email?: string) {
  const user = await testDb.user.create({
    data: {
      email: email || `test-${Date.now()}@example.com`,
      passwordHash: '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyJSawHByQBW', // hashed "password"
      isVerified: true,
      isActive: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

export async function createTestBusiness(userId: string, name?: string) {
  const count = await testDb.business.count();
  const business = await testDb.business.create({
    data: {
      userId,
      merchantId: `TEST${String(count + 1).padStart(4, '0')}`,
      businessName: name || `Test Business ${count + 1}`,
      ownerName: 'Test Owner',
      taxId: `TAX-${Date.now()}-${count}`,
      businessType: 'Retail',
    },
  });
  createdBusinessIds.add(business.id);
  return business;
}
