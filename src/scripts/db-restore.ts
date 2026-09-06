import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function runRestore() {
  const backupDir = path.resolve(__dirname, '../../backups');
  const specifiedFile = process.argv[2];
  const targetFile = specifiedFile
    ? path.resolve(backupDir, specifiedFile)
    : path.resolve(backupDir, 'latest-backup.json');

  if (!fs.existsSync(targetFile)) {
    console.error(`❌ Backup file not found: ${targetFile}`);
    process.exit(1);
  }

  console.log(`🔄 Restoring database from physical backup: ${path.basename(targetFile)}`);
  const startTime = Date.now();
  const rawData = fs.readFileSync(targetFile, 'utf-8');
  const backup = JSON.parse(rawData);
  const data = backup.data;

  // Restore in dependency order using batch inserts with skipDuplicates
  if (data.users?.length) {
    console.log(`⏳ Restoring ${data.users.length} users...`);
    for (const u of data.users) {
      await prisma.user.upsert({
        where: { id: u.id },
        create: u,
        update: u,
      });
    }
  }

  if (data.businesses?.length) {
    console.log(`⏳ Restoring ${data.businesses.length} businesses...`);
    for (const b of data.businesses) {
      await prisma.business.upsert({
        where: { id: b.id },
        create: b,
        update: b,
      });
    }
  }

  if (data.banks?.length) {
    console.log(`⏳ Restoring ${data.banks.length} banks in batch...`);
    await prisma.bank.createMany({
      data: data.banks,
      skipDuplicates: true,
    });
  }

  if (data.customers?.length) {
    console.log(`⏳ Restoring ${data.customers.length} customers...`);
    await prisma.customer.createMany({
      data: data.customers,
      skipDuplicates: true,
    });
  }

  if (data.transactionClassifications?.length) {
    console.log(`⏳ Restoring transaction classifications...`);
    await prisma.transactionClassification.createMany({
      data: data.transactionClassifications,
      skipDuplicates: true,
    });
  }

  if (data.salesTransactions?.length) {
    console.log(`⏳ Restoring ${data.salesTransactions.length} sales transactions...`);
    await prisma.salesTransaction.createMany({
      data: data.salesTransactions,
      skipDuplicates: true,
    });
  }

  if (data.saleLineItems?.length) {
    console.log(`⏳ Restoring sale line items...`);
    await prisma.saleLineItem.createMany({
      data: data.saleLineItems,
      skipDuplicates: true,
    });
  }

  if (data.expenses?.length) {
    console.log(`⏳ Restoring ${data.expenses.length} expenses...`);
    await prisma.expense.createMany({
      data: data.expenses,
      skipDuplicates: true,
    });
  }

  if (data.monthlyTaxReports?.length) {
    console.log(`⏳ Restoring monthly tax reports...`);
    await prisma.monthlyTaxReport.createMany({
      data: data.monthlyTaxReports,
      skipDuplicates: true,
    });
  }

  if (data.taxPayments?.length) {
    console.log(`⏳ Restoring tax payments...`);
    await prisma.taxPayment.createMany({
      data: data.taxPayments,
      skipDuplicates: true,
    });
  }

  if (data.firsRemittances?.length) {
    console.log(`⏳ Restoring firs remittances...`);
    await prisma.firsRemittance.createMany({
      data: data.firsRemittances,
      skipDuplicates: true,
    });
  }

  if (data.taxStatements?.length) {
    console.log(`⏳ Restoring tax statements...`);
    await prisma.taxStatement.createMany({
      data: data.taxStatements,
      skipDuplicates: true,
    });
  }

  if (data.invoices?.length) {
    console.log(`⏳ Restoring invoices...`);
    await prisma.invoice.createMany({
      data: data.invoices,
      skipDuplicates: true,
    });
  }

  if (data.invoiceLines?.length) {
    console.log(`⏳ Restoring invoice lines...`);
    await prisma.invoiceLine.createMany({
      data: data.invoiceLines,
      skipDuplicates: true,
    });
  }

  if (data.reminders?.length) {
    console.log(`⏳ Restoring reminders...`);
    await prisma.reminder.createMany({
      data: data.reminders,
      skipDuplicates: true,
    });
  }

  if (data.settlementPayouts?.length) {
    console.log(`⏳ Restoring settlement payouts...`);
    await prisma.settlementPayout.createMany({
      data: data.settlementPayouts,
      skipDuplicates: true,
    });
  }

  if (data.paystackWebhookEvents?.length) {
    console.log(`⏳ Restoring webhook events...`);
    await prisma.paystackWebhookEvent.createMany({
      data: data.paystackWebhookEvents,
      skipDuplicates: true,
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Database successfully restored from ${path.basename(targetFile)}!`);
  console.log(`⏱️ Completed in ${elapsed}s.`);
}

runRestore()
  .catch((err) => {
    console.error('❌ Restore failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
