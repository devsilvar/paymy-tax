// Smoke for the *manual* "Generate Reminders" path.
// Calls generateReminders() directly (same as the POST /generate endpoint)
// against every business that has an overdue or past-due invoice — so we
// can see which business currently has the issue you described.

import prisma from '../src/lib/prisma';
import { generateReminders } from '../src/services/reminder.service';

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find every invoice that is "actually overdue" today, regardless of status.
  // We include `overdue` rows too because if you ran the cron earlier the
  // status flip already happened — but the reminder may have been dismissed,
  // so we still want to report the invoice as a candidate.
  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      status: { in: ['sent', 'overdue'] },
      dueDate: { lt: today },
    },
    select: {
      id: true,
      businessId: true,
      invoiceNumber: true,
      customerName: true,
      total: true,
      dueDate: true,
      status: true,
      business: { select: { businessName: true, userId: true, user: { select: { email: true } } } },
    },
    orderBy: { dueDate: 'asc' },
  });

  console.log(`\nFound ${overdueInvoices.length} overdue invoice(s) across all businesses:\n`);
  for (const inv of overdueInvoices) {
    console.log(`  • ${inv.invoiceNumber} — ${inv.business.businessName} (owner: ${inv.business.user.email})`);
    console.log(`      due ${inv.dueDate.toISOString().slice(0, 10)}, status=${inv.status}, total=₦${inv.total}`);
  }

  if (overdueInvoices.length === 0) {
    console.log('Nothing to test. Create a sent invoice with a past dueDate first.');
    await prisma.$disconnect();
    process.exit(0);
  }

  // Group by business and call generateReminders for each.
  const byBiz = new Map<string, { userId: string; name: string }>();
  for (const inv of overdueInvoices) {
    byBiz.set(inv.businessId, {
      userId: inv.business.userId,
      name: inv.business.businessName,
    });
  }

  const now = new Date();
  for (const [businessId, b] of byBiz) {
    console.log(`\n--- Calling generateReminders for ${b.name} ---`);
    const result = await generateReminders(
      b.userId,
      businessId,
      now.getMonth() + 1,
      now.getFullYear()
    );
    console.log(JSON.stringify(result, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
