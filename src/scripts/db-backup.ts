import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
    walletBalances,
    walletTransactions,
    platformFeeConfigs,
    aiProviderConfigs,
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
    prisma.walletBalance.findMany(),
    prisma.walletTransaction.findMany(),
    prisma.platformFeeConfig.findMany(),
    prisma.aiProviderConfig.findMany(),
  ]);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.json`;
  const filepath = path.join(backupDir, filename);

  const backupData = {
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
    walletBalances,
    walletTransactions,
    platformFeeConfigs,
    aiProviderConfigs,
  };

  const serializedData = JSON.stringify(backupData);
  const checksum = crypto.createHash('sha256').update(serializedData).digest('hex');

  const backupPayload = {
    metadata: {
      createdAt: new Date().toISOString(),
      version: '1.1',
      checksum,
      recordCounts: {
        users: users.length,
        businesses: businesses.length,
        banks: banks.length,
        customers: customers.length,
        transactionClassifications: transactionClassifications.length,
        salesTransactions: salesTransactions.length,
        saleLineItems: saleLineItems.length,
        expenses: expenses.length,
        invoices: invoices.length,
        invoiceLines: invoiceLines.length,
        monthlyTaxReports: monthlyTaxReports.length,
        taxPayments: taxPayments.length,
        firsRemittances: firsRemittances.length,
        taxStatements: taxStatements.length,
        reminders: reminders.length,
        settlementPayouts: settlementPayouts.length,
        paystackWebhookEvents: paystackWebhookEvents.length,
        auditLogs: auditLogs.length,
        walletBalances: walletBalances.length,
        walletTransactions: walletTransactions.length,
        platformFeeConfigs: platformFeeConfigs.length,
        aiProviderConfigs: aiProviderConfigs.length,
      },
    },
    data: backupData,
  };

  fs.writeFileSync(filepath, JSON.stringify(backupPayload, null, 2), 'utf-8');

  // Also maintain a 'latest-backup.json' copy for easy one-step restore
  const latestPath = path.join(backupDir, 'latest-backup.json');
  fs.writeFileSync(latestPath, JSON.stringify(backupPayload, null, 2), 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Database backup successfully saved to: ${filepath}`);
  console.log(`📊 Summary (Checksum: ${checksum.slice(0, 12)}...):`);
  console.log(`   - Users: ${users.length}`);
  console.log(`   - Businesses: ${businesses.length}`);
  console.log(`   - Sales Transactions: ${salesTransactions.length}`);
  console.log(`   - Expenses: ${expenses.length}`);
  console.log(`   - Invoices: ${invoices.length}`);
  console.log(`   - Tax Reports: ${monthlyTaxReports.length}`);
  console.log(`   - Platform Fee Configs: ${platformFeeConfigs.length}`);
  console.log(`   - AI Provider Configs: ${aiProviderConfigs.length}`);
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
