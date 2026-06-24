import { PrismaClient } from '@prisma/client';

export const testDb = new PrismaClient();

export async function clearDatabase() {
  // Clear in correct order (respecting foreign keys)
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
