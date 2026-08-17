/**
 * DVA Webhook Diagnostic Script
 * 
 * Checks each layer of the DVA → Sales pipeline to identify where
 * transactions might be getting stuck.
 * 
 * Usage:
 *   npx tsx scripts/diagnose-dva-webhooks.ts <businessId>
 * 
 * Example:
 *   npx tsx scripts/diagnose-dva-webhooks.ts 0ca4c440-5358-4ac6-923c-71317014baf7
 */

import prisma from '../src/lib/prisma';

const businessId = process.argv[2];

if (!businessId) {
  console.error('❌ Usage: npx tsx scripts/diagnose-dva-webhooks.ts <businessId>');
  process.exit(1);
}

async function diagnose() {
  console.log('🔍 DVA Webhook Pipeline Diagnostic\n');
  console.log(`Business ID: ${businessId}\n`);

  // Step 1: Verify business exists and has DVA
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Step 1: Business & DVA Configuration');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      businessName: true,
      virtualAccountNumber: true,
      virtualAccountBank: true,
      paystackCustomerCode: true,
      paystackSubaccountCode: true,
      settlementBankName: true,
      settlementAccountNumber: true,
    },
  });

  if (!business) {
    console.error('❌ Business not found!');
    process.exit(1);
  }

  console.log(`✅ Business: ${business.businessName}`);
  
  if (business.virtualAccountNumber) {
    console.log(`✅ DVA Assigned: ${business.virtualAccountNumber} (${business.virtualAccountBank})`);
  } else {
    console.log('❌ No DVA assigned to this business');
    console.log('   → Set up DVA first via POST /dva/setup-virtual-account');
    process.exit(1);
  }

  if (business.paystackCustomerCode) {
    console.log(`✅ Paystack Customer: ${business.paystackCustomerCode}`);
  }

  if (business.paystackSubaccountCode) {
    console.log(`✅ Split Settlement: Configured`);
    console.log(`   → Bank: ${business.settlementBankName}`);
    console.log(`   → Account: ${business.settlementAccountNumber}`);
  } else {
    console.log('⚠️  No split settlement configured (funds pool in platform balance)');
  }

  // Step 2: Check webhook events
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📡 Step 2: Paystack Webhook Events');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const webhookEvents = await prisma.paystackWebhookEvent.findMany({
    where: {
      OR: [
        { rawBody: { contains: business.virtualAccountNumber! } },
        { event: 'charge.success' },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log(`Found ${webhookEvents.length} recent webhook events\n`);

  if (webhookEvents.length === 0) {
    console.log('❌ No webhook events found!');
    console.log('\n🔧 Troubleshooting:');
    console.log('   1. Check Paystack Dashboard → Settings → API Keys & Webhooks');
    console.log('   2. Verify webhook URL is set: https://paymy-tax.onrender.com/webhooks/paystack');
    console.log('   3. Check webhook delivery logs in Paystack dashboard');
    console.log('   4. Test with a small transfer to the DVA account');
    process.exit(0);
  }

  // Show recent webhook events
  for (const event of webhookEvents.slice(0, 5)) {
    const statusEmoji = event.status === 'processed' ? '✅' : event.status === 'failed' ? '❌' : '⏳';
    console.log(`${statusEmoji} ${event.event} - ${event.createdAt.toISOString()}`);
    console.log(`   Status: ${event.status}`);
    if (event.reference) console.log(`   Reference: ${event.reference}`);
    if (event.error) console.log(`   ❌ Error: ${event.error}`);
    
    // Check if it's a DVA transfer
    const rawBody = JSON.parse(event.rawBody);
    if (rawBody.data?.channel === 'dedicated_nuban') {
      const accountNumber = rawBody.data?.authorization?.receiver_bank_account_number ||
                           rawBody.data?.dedicated_account?.account_number;
      if (accountNumber === business.virtualAccountNumber) {
        console.log(`   💰 DVA Transfer: ₦${(rawBody.data.amount / 100).toFixed(2)}`);
      }
    }
    console.log('');
  }

  // Step 3: Check sales transactions
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💰 Step 3: Sales Transactions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const [allSales, pendingSales, confirmedSales] = await Promise.all([
    prisma.salesTransaction.count({ where: { businessId } }),
    prisma.salesTransaction.count({ where: { businessId, status: 'pending' } }),
    prisma.salesTransaction.count({ where: { businessId, status: 'confirmed' } }),
  ]);

  console.log(`Total Sales: ${allSales}`);
  console.log(`  ⏳ Pending: ${pendingSales}`);
  console.log(`  ✅ Confirmed: ${confirmedSales}\n`);

  // Check unverified transactions
  const unverified = await prisma.salesTransaction.findMany({
    where: { businessId, needsVerification: true },
    orderBy: { transactionDate: 'desc' },
    take: 10,
    select: {
      id: true,
      amount: true,
      source: true,
      status: true,
      referenceId: true,
      customerName: true,
      transactionDate: true,
      needsVerification: true,
      metadata: true,
    },
  });

  if (unverified.length > 0) {
    console.log(`⚠️  ${unverified.length} transactions need verification:\n`);
    
    for (const sale of unverified.slice(0, 5)) {
      console.log(`  ID: ${sale.id}`);
      console.log(`  Amount: ₦${sale.amount.toFixed(2)}`);
      console.log(`  Source: ${sale.source}`);
      console.log(`  Status: ${sale.status}`);
      console.log(`  Customer: ${sale.customerName || 'N/A'}`);
      console.log(`  Date: ${sale.transactionDate.toISOString()}`);
      if (sale.referenceId) console.log(`  Reference: ${sale.referenceId}`);
      
      const metadata = sale.metadata as any;
      if (metadata?.channel === 'dva') {
        console.log(`  ✅ Auto-captured from DVA`);
      }
      
      console.log(`  🔧 To verify: POST /api/v1/businesses/${businessId}/sales/${sale.id}/verify`);
      console.log(`     Body: { "classification": "sale" }\n`);
    }

    console.log('\n💡 These transactions are waiting for manual verification.');
    console.log('   Once verified, they will appear in /sales/summary.');
  } else if (allSales === 0) {
    console.log('❌ No sales transactions found!');
    console.log('\n🔧 Possible causes:');
    console.log('   1. Webhook processing failed (check errors above)');
    console.log('   2. No payments have been received to the DVA yet');
    console.log('   3. processDVATransferWebhook is not matching the account number');
  } else {
    console.log('✅ All transactions have been verified!');
  }

  // Step 4: Monthly summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Step 4: Monthly Summary (Confirmed Only)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);

  const summary = await prisma.salesTransaction.aggregate({
    where: {
      businessId,
      transactionDate: { gte: monthStart, lte: monthEnd },
      status: 'confirmed',
    },
    _sum: { amount: true },
    _count: true,
  });

  console.log(`Month: ${year}-${month.toString().padStart(2, '0')}`);
  console.log(`Total Confirmed Sales: ₦${(summary._sum.amount || 0).toFixed(2)}`);
  console.log(`Transaction Count: ${summary._count}\n`);

  if (confirmedSales === 0 && pendingSales > 0) {
    console.log('⚠️  You have pending transactions but no confirmed ones.');
    console.log('   Summary will show ₦0 until you verify pending transactions.');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Diagnostic Complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('📋 Quick Reference:');
  console.log(`   Unverified: GET /api/v1/businesses/${businessId}/sales/unverified`);
  console.log(`   All Sales:  GET /api/v1/businesses/${businessId}/sales`);
  console.log(`   Summary:    GET /api/v1/businesses/${businessId}/sales/summary?month=${month}&year=${year}`);
  console.log(`   Verify:     POST /api/v1/businesses/${businessId}/sales/{saleId}/verify\n`);
}

diagnose()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
