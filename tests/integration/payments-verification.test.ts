import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import * as dvaService from '../../src/services/dva.service';
import * as salesService from '../../src/services/sales.service';
import * as taxService from '../../src/services/tax.service';
import { DEFAULT_CLASSIFICATIONS } from '../../prisma/seeds/transaction-classifications';

/**
 * Payments & Transaction Verification Integration Tests
 *
 * Verifies:
 * 1. Paystack DVA Webhook auto-capture into sales_transactions (pending, needsVerification).
 * 2. Webhook idempotency (duplicate transfers ignored safely).
 * 3. DVA Balance & Transaction summaries (confirmed vs pendingVerification).
 * 4. Verification Workflow: Classifying transactions as Taxable (Product Sale) vs Non-Taxable (Capital / Loan / Personal).
 * 5. Tax Calculation Engine: Confirms that non-taxable transactions are excluded from tax calculation,
 *    while taxable transactions are included in Gross Profit and 7.5% Tax Payable.
 */
describe('DVA Payments, Transaction Verification & Tax Treatment', () => {
  let userId: string;
  let businessId: string;
  const virtualAccount = '9816260527';

  beforeAll(async () => {
    await clearDatabase();

    // Ensure classifications are seeded in test database
    await testDb.transactionClassification.deleteMany();
    for (const c of DEFAULT_CLASSIFICATIONS) {
      await testDb.transactionClassification.create({ data: c });
    }

    // Create user and business with virtual account
    const user = await createTestUser('fintech-test@example.com');
    userId = user.id;

    const business = await createTestBusiness(userId, 'Fintech Retail Store');
    businessId = business.id;

    // Attach virtual account number to the business
    await testDb.business.update({
      where: { id: businessId },
      data: {
        virtualAccountNumber: virtualAccount,
        virtualAccountBank: 'Wema Bank',
      },
    });
  }, 30000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 30000);

  // ─── 1. Webhook Ingestion & Auto-Capture ─────────────────────

  test('Paystack charge.success webhook auto-captures DVA transfer as pending sale needing verification', async () => {
    const reference = `TEST-DVA-${Date.now()}-1`;
    const fakeWebhookEvent = {
      event: 'charge.success',
      data: {
        id: 99001122,
        reference,
        amount: 5000000, // 50,000 NGN in kobo
        channel: 'dedicated_nuban',
        paid_at: new Date('2026-03-10T10:00:00Z').toISOString(),
        narration: 'Payment for inventory order #104',
        customer: {
          first_name: 'Ade',
          last_name: 'Bello',
          email: 'ade.bello@example.com',
        },
        authorization: {
          receiver_bank_account_number: virtualAccount,
          receiver_bank: 'Wema Bank',
        },
      },
    };

    const handled = await dvaService.processDVATransferWebhook(fakeWebhookEvent);
    expect(handled).toBe(true);

    // Verify transaction created in DB
    const saved = await testDb.salesTransaction.findFirst({
      where: { referenceId: reference, businessId },
    });

    expect(saved).not.toBeNull();
    expect(Number(saved!.amount)).toBe(50000);
    expect(saved!.source).toBe('bank_transfer');
    expect(saved!.status).toBe('pending');
    expect(saved!.needsVerification).toBe(true);
    expect(saved!.customerName).toBe('Ade Bello');
  });

  test('Webhook processing is idempotent on duplicate delivery', async () => {
    const duplicateRef = `TEST-DUP-${Date.now()}`;
    const webhookPayload = {
      event: 'charge.success',
      data: {
        id: 99003344,
        reference: duplicateRef,
        amount: 1000000, // 10,000 NGN in kobo
        channel: 'dedicated_nuban',
        paid_at: new Date('2026-03-12T12:00:00Z').toISOString(),
        authorization: {
          receiver_bank_account_number: virtualAccount,
        },
      },
    };

    // First delivery
    const firstAttempt = await dvaService.processDVATransferWebhook(webhookPayload);
    expect(firstAttempt).toBe(true);

    // Second delivery (Paystack retry)
    const secondAttempt = await dvaService.processDVATransferWebhook(webhookPayload);
    expect(secondAttempt).toBe(true);

    // Only 1 record should exist in the database
    const matchingRecords = await testDb.salesTransaction.findMany({
      where: { referenceId: duplicateRef, businessId },
    });
    expect(matchingRecords).toHaveLength(1);
  });

  // ─── 2. DVA Balance & Metrics Calculation ───────────────────

  test('getDVABalance correctly reports pendingVerification vs confirmed amounts', async () => {
    const balance = await dvaService.getDVABalance(userId, businessId);

    expect(balance.accountNumber).toBe(virtualAccount);
    expect(balance.accountStatus).toBe('active');
    // 50,000 + 10,000 = 60,000 currently pending verification
    expect(Number(balance.pendingVerification.total)).toBe(60000);
    expect(balance.pendingVerification.count).toBe(2);
    expect(Number(balance.confirmed.total)).toBe(0);
  });

  // ─── 3. Verification Workflow (Taxable vs Non-Taxable) ───────

  test('Verifying a transaction as Taxable Revenue (Product Sale) sets isTaxable=true and status=confirmed', async () => {
    const unverifiedList = await salesService.getUnverifiedSales(userId, businessId);
    expect(unverifiedList.data.length).toBeGreaterThanOrEqual(1);

    const firstSale = unverifiedList.data[0];

    // Verify as "Product Sale" (Taxable)
    const verified = await salesService.verifySale(
      userId,
      businessId,
      firstSale.id,
      'Product Sale'
    );

    expect(verified.needsVerification).toBe(false);
    expect(verified.status).toBe('confirmed');
    expect(verified.isTaxable).toBe(true);
    expect(verified.finalClassification).toBe('Product Sale');
  });

  test('Verifying a transaction as Non-Taxable (Capital Injection) sets isTaxable=false and status=confirmed', async () => {
    const unverifiedList = await salesService.getUnverifiedSales(userId, businessId);
    expect(unverifiedList.data.length).toBeGreaterThanOrEqual(1);

    const secondSale = unverifiedList.data[0];

    // Verify as "Capital Injection" (Non-Taxable)
    const verified = await salesService.verifySale(
      userId,
      businessId,
      secondSale.id,
      'Capital Injection'
    );

    expect(verified.needsVerification).toBe(false);
    expect(verified.status).toBe('confirmed');
    expect(verified.isTaxable).toBe(false);
    expect(verified.finalClassification).toBe('Capital Injection');
  });

  // ─── 4. Tax Calculation Integration ─────────────────────────

  test('Tax calculation includes taxable revenue and completely excludes non-taxable transactions', async () => {
    // Current state in test:
    // - Sale 1: 50,000 NGN -> Confirmed, isTaxable = true (Product Sale)
    // - Sale 2: 10,000 NGN -> Confirmed, isTaxable = false (Capital Injection)
    // - Total taxable sales in March 2026 = 50,000 NGN (10,000 Capital is excluded)
    //
    // Let's add an expense of 10,000 NGN for March 2026:
    await testDb.expense.create({
      data: {
        businessId,
        amount: 10000,
        category: 'supplies',
        description: 'Store packaging materials',
        expenseDate: new Date('2026-03-15T10:00:00Z'),
        isDeductible: true,
      },
    });

    // Calculate tax for March 2026 (Month 3, Year 2026)
    const taxReport = await taxService.calculateTax(userId, businessId, 2026, 3);

    // Expected:
    // Total Sales (Taxable only) = 50,000
    // Total Expenses = 10,000
    // Gross Profit = 50,000 - 10,000 = 40,000
    // Tax Payable (7.5%) = 40,000 * 0.075 = 3,000
    expect(Number(taxReport.totalSales)).toBe(50000);
    expect(Number(taxReport.totalExpenses)).toBe(10000);
    expect(Number(taxReport.grossProfit)).toBe(40000);
    expect(Number(taxReport.taxRate)).toBe(7.5);
    expect(Number(taxReport.taxPayable)).toBe(3000);
  });
});
