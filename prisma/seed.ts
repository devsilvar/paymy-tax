/**
 * Database Seed Script
 * 
 * Seeds the database with test data for development.
 * 
 * Run with: npm run prisma:seed
 * 
 * @author WallX Engineering Team
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { seedTransactionClassifications } from './seeds/transaction-classifications';

const prisma = new PrismaClient();

/**
 * Hash password helper
 */
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Main seed function
 */
async function main() {
  console.log('🌱 Starting database seed...\n');

  // =================================
  // 0. SEED TRANSACTION CLASSIFICATIONS
  // =================================
  await seedTransactionClassifications();
  console.log('');

  // =================================
  // 1. CREATE ADMIN USER
  // =================================
  console.log('🔑 Creating admin user...');

  const defaultPinHash = await hashPassword('1234');

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@paymytax.com' },
    update: {
      bvn: '22222222221',
      bvnVerifiedAt: new Date(),
      transactionPin: defaultPinHash,
      pinSetAt: new Date(),
    },
    create: {
      email: 'admin@paymytax.com',
      passwordHash: await hashPassword('Admin@123456'),
      role: 'admin',
      bvn: '22222222221',
      bvnVerifiedAt: new Date(),
      transactionPin: defaultPinHash,
      pinSetAt: new Date(),
      isVerified: true,
      isActive: true,
    },
  });

  console.log(`✅ Created admin user: ${adminUser.email}\n`);

  // =================================
  // 1. CREATE TEST USERS
  // =================================
  console.log('📝 Creating test users...');

  const testUser1 = await prisma.user.upsert({
    where: { email: 'john@example.com' },
    update: {
      bvn: '22222222221',
      bvnVerifiedAt: new Date(),
      transactionPin: defaultPinHash,
      pinSetAt: new Date(),
    },
    create: {
      email: 'john@example.com',
      passwordHash: await hashPassword('Password123!'),
      phone: '+2348012345678',
      bvn: '22222222221',
      bvnVerifiedAt: new Date(),
      transactionPin: defaultPinHash,
      pinSetAt: new Date(),
      isVerified: true,
      isActive: true,
    },
  });

  const testUser2 = await prisma.user.upsert({
    where: { email: 'jane@example.com' },
    update: {
      bvn: '22222222222',
      bvnVerifiedAt: new Date(),
      transactionPin: defaultPinHash,
      pinSetAt: new Date(),
    },
    create: {
      email: 'jane@example.com',
      passwordHash: await hashPassword('Password123!'),
      phone: '+2348087654321',
      bvn: '22222222222',
      bvnVerifiedAt: new Date(),
      transactionPin: defaultPinHash,
      pinSetAt: new Date(),
      isVerified: true,
      isActive: true,
    },
  });

  console.log(`✅ Created users: ${testUser1.email}, ${testUser2.email}\n`);

  // =================================
  // 2. CREATE TEST BUSINESSES
  // =================================
  console.log('🏢 Creating test businesses...');

  const business1 = await prisma.business.upsert({
    where: { taxId: '12345678-0001' },
    update: {},
    create: {
      userId: testUser1.id,
      merchantId: 'PMTW001',
      businessName: 'ABC Retail Store',
      ownerName: 'John Doe',
      taxId: '12345678-0001',
      businessType: 'Retail',
      address: '123 Market Street',
      city: 'Lagos',
      state: 'Lagos',
      defaultProfitMargin: 25.00,
      taxReminderDay: 25,
    },
  });

  const business2 = await prisma.business.upsert({
    where: { taxId: '12345678-0002' },
    update: {},
    create: {
      userId: testUser2.id,
      merchantId: 'PMTW002',
      businessName: 'Tech Solutions Ltd',
      ownerName: 'Jane Smith',
      taxId: '12345678-0002',
      businessType: 'Technology',
      address: '456 Tech Avenue',
      city: 'Abuja',
      state: 'FCT',
      defaultProfitMargin: 30.00,
      taxReminderDay: 20,
    },
  });

  console.log(`✅ Created businesses: ${business1.businessName}, ${business2.businessName}\n`);

  // =================================
  // 3. CREATE SAMPLE SALES TRANSACTIONS
  // =================================
  console.log('💰 Creating sample sales transactions...');

  const salesData = [
    { amount: 150000, source: 'pos', description: 'POS sales - Week 1', date: new Date('2026-03-05') },
    { amount: 200000, source: 'bank_transfer', description: 'Bank transfer payment', date: new Date('2026-03-10') },
    { amount: 75000, source: 'paycode', description: 'PayCode transaction', date: new Date('2026-03-15') },
    { amount: 180000, source: 'pos', description: 'POS sales - Week 3', date: new Date('2026-03-18') },
    { amount: 95000, source: 'cash', description: 'Cash sales', date: new Date('2026-03-20') },
    { amount: 45000, source: 'cash', description: 'Walk-in cash payment', date: new Date('2026-03-22') },
    { amount: 250000, source: 'invoice', description: 'Invoice INV-2026-042 - settled via bank transfer', date: new Date('2026-03-25') },
  ];

  for (const sale of salesData) {
    await prisma.salesTransaction.create({
      data: {
        businessId: business1.id,
        amount: sale.amount,
        source: sale.source as any,
        status: 'confirmed',
        description: sale.description,
        transactionDate: sale.date,
        createdBy: testUser1.id,
      },
    });
  }

  // Sample Basket sale with line items
  await prisma.salesTransaction.create({
    data: {
      businessId: business1.id,
      amount: 12500,
      source: 'pos',
      status: 'confirmed',
      description: 'Counter sale — 3 items',
      transactionDate: new Date('2026-03-24'),
      createdBy: testUser1.id,
      items: {
        createMany: {
          data: [
            { name: 'Rice 5kg bag', quantity: 2, unitPrice: 3500, lineTotal: 7000, sortOrder: 0 },
            { name: 'Vegetable Oil 1L', quantity: 1, unitPrice: 4000, lineTotal: 4000, sortOrder: 1 },
            { name: 'Seasoning cubes pack', quantity: 3, unitPrice: 500, lineTotal: 1500, sortOrder: 2 },
          ],
        },
      },
    },
  });

  console.log(`✅ Created ${salesData.length + 1} sales transactions (including basket sale)\n`);

  // =================================
  // 4. CREATE SAMPLE EXPENSES
  // =================================
  console.log('💸 Creating sample expenses...');

  const expensesData = [
    { category: 'rent', description: 'Shop rent - March', amount: 50000, date: new Date('2026-03-01') },
    { category: 'inventory', description: 'Stock purchase', amount: 200000, date: new Date('2026-03-05') },
    { category: 'inventory', description: '12 crates of eggs', amount: 42000, quantity: 12, unitPrice: 3500, date: new Date('2026-03-08') },
    { category: 'utility', description: 'Electricity bill', amount: 15000, date: new Date('2026-03-07') },
    { category: 'salary', description: 'Staff salaries', amount: 80000, date: new Date('2026-03-15') },
    { category: 'fuel', description: 'Generator fuel', amount: 10000, date: new Date('2026-03-12') },
    { category: 'marketing', description: 'Facebook ads', amount: 5000, date: new Date('2026-03-10') },
  ];

  for (const expense of expensesData) {
    await prisma.expense.create({
      data: {
        businessId: business1.id,
        category: expense.category as any,
        description: expense.description,
        amount: expense.amount,
        quantity: (expense as any).quantity ?? 1,
        unitPrice: (expense as any).unitPrice ?? expense.amount,
        expenseDate: expense.date,
        createdBy: testUser1.id,
      },
    });
  }

  console.log(`✅ Created ${expensesData.length} expenses\n`);

  // =================================
  // 5. CREATE SAMPLE TAX REPORT
  // =================================
  console.log('📊 Creating sample tax report...');

  const totalSales = salesData.reduce((sum, sale) => sum + sale.amount, 0);
  const totalExpenses = expensesData.reduce((sum, expense) => sum + expense.amount, 0);
  const grossProfit = totalSales - totalExpenses;
  const taxPayable = grossProfit * 0.075;

  await prisma.monthlyTaxReport.upsert({
    where: {
      businessId_taxMonth: {
        businessId: business1.id,
        taxMonth: new Date('2026-03-01'),
      },
    },
    update: {},
    create: {
      businessId: business1.id,
      taxMonth: new Date('2026-03-01'),
      totalSales,
      totalExpenses,
      grossProfit,
      taxRate: 7.5,
      taxPayable,
      profitMargin: (grossProfit / totalSales) * 100,
      paymentStatus: 'pending',
      isFinalized: false,
      isLocked: false,
    },
  });

  console.log('✅ Created tax report for March 2026\n');

  // =================================
  // SUMMARY
  // =================================
  console.log('=================================');
  console.log('✅ Database seed completed!');
  console.log('=================================');
  console.log('\n📊 Test Data Summary:');
  console.log(`Users: 2`);
  console.log(`Businesses: 2`);
  console.log(`Sales Transactions: ${salesData.length}`);
  console.log(`Expenses: ${expensesData.length}`);
  console.log(`Tax Reports: 1`);
  console.log('\n🔐 Test Login Credentials:');
  console.log('Admin: admin@paymytax.com / Admin@123456');
  console.log('User:  john@example.com / Password123!');
  console.log('\n');
}

/**
 * Execute seed and handle errors
 */
main()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
