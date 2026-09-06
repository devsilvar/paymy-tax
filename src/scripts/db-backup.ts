import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function runBackup() {
  console.log('🔄 Starting physical database backup...');
  const startTime = Date.now();

  const backupDir = path.resolve(__dirname, '../../backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Fetch data in topological dependency order
  const [
    users,
    businesses,
    banks,
    customers,
    transactionClassifications,
    salesTransactions,
    saleLineItems,
    expenses,
    monthlyTaxReports,
    taxPayments,
    firsRemittances,
    taxStatements,
    invoices,
    invoiceLines,
    reminders,
    settlementPayouts,
    paystackWebhookEvents,
    auditLogs,
  ] = await Promise.all([
    prisma.user.findMany(),
    prisma.business.findMany(),
    prisma.bank.findMany(),
    prisma.customer.findMany(),
    prisma.transactionClassification.findMany(),
    prisma.salesTransaction.findMany(),
    prisma.saleLineItem.findMany(),
    prisma.expense.findMany(),
    prisma.monthlyTaxReport.findMany(),
    prisma.taxPayment.findMany(),
    prisma.firsRemittance.findMany(),
    prisma.taxStatement.findMany(),
    prisma.invoice.findMany(),
    prisma.invoiceLine.findMany(),
    prisma.reminder.findMany(),
    prisma.settlementPayout.findMany(),
    prisma.paystackWebhookEvent.findMany(),
    prisma.auditLog.findMany(),
  ]);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.json`;
  const filepath = path.join(backupDir, filename);

  const backupPayload = {
    metadata: {
      createdAt: new Date().toISOString(),
      version: '1.0',
      recordCounts: {
        users: users.length,
        businesses: businesses.length,
        banks: banks.length,
        customers: customers.length,
        salesTransactions: salesTransactions.length,
        expenses: expenses.length,
        invoices: invoices.length,
        monthlyTaxReports: monthlyTaxReports.length,
        settlementPayouts: settlementPayouts.length,
      },
    },
    data: {
      users,
      businesses,
      banks,
      customers,
      transactionClassifications,
      salesTransactions,
      saleLineItems,
      expenses,
      monthlyTaxReports,
      taxPayments,
      firsRemittances,
      taxStatements,
      invoices,
      invoiceLines,
      reminders,
      settlementPayouts,
      paystackWebhookEvents,
      auditLogs,
    },
  };

  fs.writeFileSync(filepath, JSON.stringify(backupPayload, null, 2), 'utf-8');

  // Also maintain a 'latest-backup.json' copy for easy one-step restore
  const latestPath = path.join(backupDir, 'latest-backup.json');
  fs.writeFileSync(latestPath, JSON.stringify(backupPayload, null, 2), 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Database backup successfully saved to: ${filepath}`);
  console.log(`📊 Summary:`);
  console.log(`   - Users: ${users.length}`);
  console.log(`   - Businesses: ${businesses.length}`);
  console.log(`   - Sales Transactions: ${salesTransactions.length}`);
  console.log(`   - Expenses: ${expenses.length}`);
  console.log(`   - Invoices: ${invoices.length}`);
  console.log(`   - Tax Reports: ${monthlyTaxReports.length}`);
  console.log(`⏱️ Completed in ${elapsed}s`);
}

runBackup()
  .catch((err) => {
    console.error('❌ Backup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
