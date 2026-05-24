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
  // 0. CREATE ADMIN USER
  // =================================
  console.log('🔑 Creating admin user...');

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@paymytax.com' },
    update: {},
    create: {
      email: 'admin@paymytax.com',
      passwordHash: await hashPassword('Admin@123456'),
      role: 'admin',
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
    update: {},
    create: {
      email: 'john@example.com',
      passwordHash: await hashPassword('Password123!'),
      phone: '+2348012345678',
      isVerified: true,
      isActive: true,
    },
  });

  const testUser2 = await prisma.user.upsert({
    where: { email: 'jane@example.com' },
    update: {},
    create: {
      email: 'jane@example.com',
      passwordHash: await hashPassword('Password123!'),
      phone: '+2348087654321',
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
    { amount: 95000, source: 'manual', description: 'Cash sales', date: new Date('2026-03-20') },
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

  console.log(`✅ Created ${salesData.length} sales transactions\n`);

  // =================================
  // 4. CREATE SAMPLE EXPENSES
  // =================================
  console.log('💸 Creating sample expenses...');

  const expensesData = [
    { category: 'rent', description: 'Shop rent - March', amount: 50000, date: new Date('2026-03-01') },
    { category: 'inventory', description: 'Stock purchase', amount: 200000, date: new Date('2026-03-05') },
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

  await prisma.monthlyTaxReport.create({
    data: {
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
