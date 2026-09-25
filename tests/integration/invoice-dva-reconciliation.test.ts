import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import * as invoiceService from '../../src/services/invoice.service';
import type { Application } from 'express';

describe('Senior QA Audit: Invoice ↔ DVA Transfer Reconciliation', () => {
  let app: Application;
  let userA: any;
  let userB: any;
  let businessA: any;
  let businessB: any;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    app = createApp();
    await clearDatabase();

    // Ensure default classifications exist
    await testDb.transactionClassification.upsert({
      where: { name: 'Product Sale' },
      update: { isActive: true, isRevenue: true, taxTreatment: 'taxable' },
      create: {
        name: 'Product Sale',
        category: 'revenue',
        taxTreatment: 'taxable',
        isRevenue: true,
        isActive: true,
        description: 'Money from selling goods or products',
      },
    });

    userA = await createTestUser('qa-invoice-dva-a@example.com');
    userB = await createTestUser('qa-invoice-dva-b@example.com');

    businessA = await createTestBusiness(userA.id, 'QA Alpha Invoicing Ltd');
    businessB = await createTestBusiness(userB.id, 'QA Beta Invoicing Ltd');

    tokenA = jwt.sign(
      { userId: userA.id, email: userA.email, role: 'user' },
      config.jwt.accessSecret,
      { expiresIn: '1h' },
    );

    tokenB = jwt.sign(
      { userId: userB.id, email: userB.email, role: 'user' },
      config.jwt.accessSecret,
      { expiresIn: '1h' },
    );
  }, 40000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 40000);

  // Helper to create a test invoice
  async function createInvoice(userId: string, businessId: string, amount: number) {
    const today = new Date();
    const dueDate = new Date();
    dueDate.setDate(today.getDate() + 14);

    return invoiceService.createInvoice(userId, businessId, {
      customerName: 'Adebayo Ogunlesi',
      customerEmail: 'adebayo@example.com',
      issueDate: today,
      dueDate,
      vatRate: 0, // 0% VAT for simple exact amount math
      discount: 0,
      lines: [
        {
          description: 'Consulting & Engineering Retainer',
          quantity: 1,
          unitPrice: amount,
        },
      ],
    });
  }

  // Helper to create an incoming DVA bank transfer
  async function createDvaTransfer(businessId: string, amount: number, reference?: string) {
    return testDb.salesTransaction.create({
      data: {
        businessId,
        amount,
        source: 'bank_transfer',
        dvaOrigin: true,
        status: 'pending',
        needsVerification: true,
        referenceId: reference || `PAYSTACK-DVA-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        customerName: 'Adebayo Ogunlesi via Access Bank',
        description: 'Dedicated Virtual Account direct transfer',
        transactionDate: new Date(),
        metadata: {
          channel: 'dva',
          paystackTransactionId: 987654321,
          originatingBank: 'Access Bank',
          senderName: 'ADEBAYO OGUNLESI',
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. HAPPY PATH & CORE RECONCILIATION GUARANTEES
  // ═══════════════════════════════════════════════════════════════

  test('TC-01: Reconcile valid DVA transfer to sent invoice (Zero revenue duplication)', async () => {
    // 1. Create and send invoice for ₦100,000
    const invoice = await createInvoice(userA.id, businessA.id, 100000);
    const sentInvoice = await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);
    expect(sentInvoice.status).toBe('sent');

    // 2. Incoming DVA bank transfer of ₦100,000
    const paystackRef = `DVA-TEST-REF-${Date.now()}`;
    const transfer = await createDvaTransfer(businessA.id, 100000, paystackRef);
    expect(transfer.needsVerification).toBe(true);

    const initialSalesCount = await testDb.salesTransaction.count({
      where: { businessId: businessA.id },
    });

    // 3. Reconcile
    const reconciled = await invoiceService.reconcileDvaTransferToInvoice(
      userA.id,
      businessA.id,
      invoice.id,
      transfer.id,
    );

    // 4. Verify Invoice state
    expect(reconciled.status).toBe('paid');
    expect(reconciled.paymentMethod).toBe('bank_transfer');
    expect(reconciled.linkedSaleId).toBe(transfer.id);
    expect(reconciled.paidAt).toBeDefined();

    // 5. CRITICAL: Verify NO duplicate SalesTransaction was created!
    const finalSalesCount = await testDb.salesTransaction.count({
      where: { businessId: businessA.id },
    });
    expect(finalSalesCount).toBe(initialSalesCount);

    // 6. Verify SalesTransaction is verified and confirmed
    const updatedSale = await testDb.salesTransaction.findUnique({
      where: { id: transfer.id },
    });
    expect(updatedSale?.needsVerification).toBe(false);
    expect(updatedSale?.status).toBe('confirmed');
    expect(updatedSale?.isTaxable).toBe(true);
    expect(updatedSale?.finalClassification).toBe('Product Sale');
    expect(updatedSale?.source).toBe('bank_transfer'); // Source NOT corrupted
    expect(updatedSale?.referenceId).toBe(paystackRef); // Paystack reference preserved!
    expect(updatedSale?.customerName).toBe('Adebayo Ogunlesi');

    // 7. Verify metadata was merged without destroying original payload
    const metadata = updatedSale?.metadata as any;
    expect(metadata.channel).toBe('dva');
    expect(metadata.paystackTransactionId).toBe(987654321);
    expect(metadata.originatingBank).toBe('Access Bank');
    expect(metadata.invoiceReconciliation).toBeDefined();
    expect(metadata.invoiceReconciliation.invoiceId).toBe(invoice.id);
    expect(metadata.invoiceReconciliation.invoiceNumber).toBe(invoice.invoiceNumber);

    // 8. Verify audit log entry
    const audit = await testDb.auditLog.findFirst({
      where: {
        businessId: businessA.id,
        action: 'invoice.dva_reconciled',
        resourceId: invoice.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. AMOUNT MISMATCH GUARD
  // ═══════════════════════════════════════════════════════════════

  test('TC-02: Enforces strict exact amount match — rejects partial/overpayment', async () => {
    // Invoice is ₦250,000
    const invoice = await createInvoice(userA.id, businessA.id, 250000);
    await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);

    // Transfer is ₦200,000 (partial payment)
    const transfer = await createDvaTransfer(businessA.id, 200000);

    // Attempting to match should reject with AMOUNT_MISMATCH
    await expect(
      invoiceService.reconcileDvaTransferToInvoice(
        userA.id,
        businessA.id,
        invoice.id,
        transfer.id,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'AMOUNT_MISMATCH',
    });

    // Verify invoice is still sent and sale is still unverified
    const invAfter = await testDb.invoice.findUnique({ where: { id: invoice.id } });
    expect(invAfter?.status).toBe('sent');
    expect(invAfter?.linkedSaleId).toBeNull();

    const saleAfter = await testDb.salesTransaction.findUnique({ where: { id: transfer.id } });
    expect(saleAfter?.needsVerification).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. DOUBLE-RECONCILIATION GUARDS
  // ═══════════════════════════════════════════════════════════════

  test('TC-03: Rejects linking the same DVA transfer to multiple invoices', async () => {
    const inv1 = await createInvoice(userA.id, businessA.id, 75000);
    await invoiceService.sendInvoice(userA.id, businessA.id, inv1.id);

    const inv2 = await createInvoice(userA.id, businessA.id, 75000);
    await invoiceService.sendInvoice(userA.id, businessA.id, inv2.id);

    const transfer = await createDvaTransfer(businessA.id, 75000);

    // First match succeeds
    await invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, inv1.id, transfer.id);

    // Second match with SAME transfer must fail
    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, inv2.id, transfer.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SALE_ALREADY_RECONCILED',
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. CROSS-RECONCILIATION DEFENSE (Invoice vs. Debt/Credit)
  // ═══════════════════════════════════════════════════════════════

  test('TC-04: Cross-reconciliation defense — cannot link transfer already tied to debtor credit', async () => {
    const transfer = await createDvaTransfer(businessA.id, 50000);

    // Simulate transfer already reconciled to a credit payment
    const credit = await testDb.customerCredit.create({
      data: {
        businessId: businessA.id,
        customerName: 'Debtor Customer',
        totalAmount: 50000,
        amountPaid: 50000,
        balance: 0,
        status: 'paid',
        dueDate: new Date(),
      },
    });

    await testDb.creditPayment.create({
      data: {
        creditId: credit.id,
        amount: 50000,
        paymentDate: new Date(),
        paymentType: 'bank_transfer',
        isFullPayment: true,
        linkedSaleId: transfer.id,
      },
    });

    // Create invoice for ₦50,000
    const invoice = await createInvoice(userA.id, businessA.id, 50000);
    await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);

    // Attempting to match to invoice must be blocked by cross-reconciliation check
    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, invoice.id, transfer.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SALE_ALREADY_RECONCILED',
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. LIFECYCLE GUARDS (Draft, Paid, Cancelled)
  // ═══════════════════════════════════════════════════════════════

  test('TC-05: Rejects matching against a draft invoice', async () => {
    const invoice = await createInvoice(userA.id, businessA.id, 80000);
    expect(invoice.status).toBe('draft');

    const transfer = await createDvaTransfer(businessA.id, 80000);

    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, invoice.id, transfer.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVOICE_NOT_SENT',
    });
  });

  test('TC-06: Rejects matching against a cancelled invoice', async () => {
    const invoice = await createInvoice(userA.id, businessA.id, 60000);
    await invoiceService.cancelInvoice(userA.id, businessA.id, invoice.id, { reason: 'Order cancelled' });

    const transfer = await createDvaTransfer(businessA.id, 60000);

    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, invoice.id, transfer.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVOICE_CANCELLED',
    });
  });

  test('TC-07: Rejects matching against an already paid invoice', async () => {
    const invoice = await createInvoice(userA.id, businessA.id, 40000);
    await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);
    const transfer1 = await createDvaTransfer(businessA.id, 40000);
    await invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, invoice.id, transfer1.id);

    // Second transfer
    const transfer2 = await createDvaTransfer(businessA.id, 40000);

    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, invoice.id, transfer2.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVOICE_ALREADY_PAID',
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. INELIGIBLE SALE & TENANT ISOLATION GUARDS
  // ═══════════════════════════════════════════════════════════════

  test('TC-08: Rejects non-DVA manual sale transactions', async () => {
    const invoice = await createInvoice(userA.id, businessA.id, 30000);
    await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);

    // Regular manual sale (not DVA origin, not unverified)
    const manualSale = await testDb.salesTransaction.create({
      data: {
        businessId: businessA.id,
        amount: 30000,
        source: 'manual',
        status: 'confirmed',
        needsVerification: false,
        dvaOrigin: false,
        transactionDate: new Date(),
      },
    });

    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userA.id, businessA.id, invoice.id, manualSale.id),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_RECONCILIATION',
    });
  });

  test('TC-09: Multi-tenant security guard — User B cannot match to User A invoice', async () => {
    const invoice = await createInvoice(userA.id, businessA.id, 55000);
    await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);

    const transfer = await createDvaTransfer(businessA.id, 55000);

    // User B attempts to reconcile User A's invoice in Business A
    await expect(
      invoiceService.reconcileDvaTransferToInvoice(userB.id, businessA.id, invoice.id, transfer.id),
    ).rejects.toThrow();
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. END-TO-END HTTP REST API ROUTE TESTS
  // ═══════════════════════════════════════════════════════════════

  test('TC-10: HTTP API — POST /:id/reconcile-dva/:saleId endpoint tests', async () => {
    const invoice = await createInvoice(userA.id, businessA.id, 120000);
    await invoiceService.sendInvoice(userA.id, businessA.id, invoice.id);
    const transfer = await createDvaTransfer(businessA.id, 120000);

    // 1. Unauthenticated request must return 401
    const unauthRes = await request(app).post(
      `/api/v1/businesses/${businessA.id}/invoices/${invoice.id}/reconcile-dva/${transfer.id}`,
    );
    expect(unauthRes.status).toBe(401);

    // 2. Forbidden request (User B accessing Business A) returns 403 or 404
    const forbiddenRes = await request(app)
      .post(`/api/v1/businesses/${businessA.id}/invoices/${invoice.id}/reconcile-dva/${transfer.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(forbiddenRes.status);

    // 3. Valid authenticated reconciliation returns 200 with standard envelope
    const successRes = await request(app)
      .post(`/api/v1/businesses/${businessA.id}/invoices/${invoice.id}/reconcile-dva/${transfer.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(successRes.status).toBe(200);
    expect(successRes.body.success).toBe(true);
    expect(successRes.body.message).toBe('DVA transfer matched to invoice successfully');
    expect(successRes.body.data.status).toBe('paid');
    expect(successRes.body.data.linkedSaleId).toBe(transfer.id);

    // 4. Repeated request returns 409 conflict
    const repeatRes = await request(app)
      .post(`/api/v1/businesses/${businessA.id}/invoices/${invoice.id}/reconcile-dva/${transfer.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(repeatRes.status).toBe(409);
  });
});
