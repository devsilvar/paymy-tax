// Manual smoke test for the daily reminder cron.
// Run with: npx tsx scripts/smoke-cron.ts
//
// Steps:
//   1. Find the first business
//   2. Create one fresh `sent` invoice with dueDate=yesterday
//   3. Call runDailySweep()
//   4. Read back: invoice status flipped to overdue + new invoice_overdue reminder
//   5. Call runDailySweep() AGAIN to prove idempotency

import prisma from '../src/lib/prisma';
import { runDailySweep } from '../src/jobs/reminders.cron';

async function main() {
  console.log('\n=== Smoke test: reminder cron sweep ===\n');

  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('No business in DB. Run `npm run prisma:seed` first.');
    process.exit(1);
  }
  console.log(`✓ Using business: ${business.businessName} (${business.id})`);

  // Build a fresh invoice that will be picked up by the sweep.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const issueDate = new Date();
  issueDate.setDate(issueDate.getDate() - 5);
  issueDate.setHours(0, 0, 0, 0);

  // Use a unique invoice number per run so we don't trip the
  // (businessId, invoiceNumber) unique constraint.
  const invoiceNumber = `SMOKE-${Date.now()}`;

  const invoice = await prisma.invoice.create({
    data: {
      businessId: business.id,
      invoiceNumber,
      customerName: 'Smoke Test Customer',
      customerEmail: 'smoke@example.com',
      issueDate,
      dueDate: yesterday,
      status: 'sent',
      sentAt: issueDate,
      subtotal: 50000,
      discount: 0,
      vatRate: 7.5,
      vatAmount: 3750,
      total: 53750,
      currency: 'NGN',
      lines: {
        create: [
          {
            description: 'Smoke test line item',
            quantity: 1,
            unitPrice: 50000,
            lineTotal: 50000,
            sortOrder: 0,
          },
        ],
      },
    },
  });
  console.log(`✓ Created sent invoice: ${invoice.invoiceNumber} (id=${invoice.id})`);
  console.log(`  - dueDate=${invoice.dueDate.toISOString().slice(0, 10)} (yesterday)`);
  console.log(`  - status=${invoice.status}`);

  const remindersBefore = await prisma.reminder.count({
    where: {
      businessId: business.id,
      reminderType: 'invoice_overdue',
      referenceId: invoice.id,
    },
  });
  console.log(`✓ Reminders for this invoice before sweep: ${remindersBefore}`);

  console.log('\n--- Running sweep #1 ---\n');
  await runDailySweep();

  const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  const reminder = await prisma.reminder.findFirst({
    where: {
      businessId: business.id,
      reminderType: 'invoice_overdue',
      referenceId: invoice.id,
    },
  });

  console.log('\n--- Results after sweep #1 ---');
  console.log(`  Invoice status: ${invoiceAfter?.status} (expected: overdue)`);
  console.log(`  Reminder created: ${reminder ? 'YES' : 'NO'}`);
  if (reminder) {
    console.log(`    id=${reminder.id}`);
    console.log(`    referenceType=${reminder.referenceType}`);
    console.log(`    referenceId=${reminder.referenceId}`);
    console.log(`    isSent=${reminder.isSent}`);
    console.log(`    message=${reminder.message}`);
  }

  console.log('\n--- Running sweep #2 (idempotency check) ---\n');
  await runDailySweep();

  const remindersAfter2 = await prisma.reminder.count({
    where: {
      businessId: business.id,
      reminderType: 'invoice_overdue',
      referenceId: invoice.id,
    },
  });
  const invoiceAfter2 = await prisma.invoice.findUnique({ where: { id: invoice.id } });

  console.log('\n--- Results after sweep #2 ---');
  console.log(`  Invoice status: ${invoiceAfter2?.status} (expected: overdue, unchanged)`);
  console.log(`  Total reminders for this invoice: ${remindersAfter2} (expected: 1)`);

  console.log('\n=== Smoke test complete ===');
  console.log(`\nTo see this in the UI, log in as the user who owns business "${business.businessName}"`);
  console.log(`and click the bell icon. The "Smoke Test Customer" overdue reminder should appear.\n`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
