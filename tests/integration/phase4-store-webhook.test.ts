import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import crypto from 'crypto';
import config from '../../src/config';
import { testDb, clearDatabase } from '../helpers/test-db';
import { processWebhook } from '../../src/services/payment.service';
import { processDVATransferWebhook } from '../../src/services/dva.service';
import { eventBus, AppDomainEvents } from '../../src/core/events/event-bus';

describe('Phase 4: Storefront-Ready Integration & Webhook Routing Suite', () => {
  jest.setTimeout(60000);

  let testUser: any;
  let testBiz: any;

  beforeAll(async () => {
    testUser = await testDb.user.create({
      data: {
        email: `store-qa-${Date.now()}@example.com`,
        passwordHash: '$2b$12$hashedpassword',
        role: 'user',
        isVerified: true,
        isActive: true,
        virtualAccountNumber: '9988776655',
      },
    });

    testBiz = await testDb.business.create({
      data: {
        userId: testUser.id,
        merchantId: `M-${Date.now()}`,
        businessName: 'Phase 4 Artisan Crafts',
        ownerName: 'Folake Adeyemi',
        taxId: `TAX-${Date.now()}`,
        businessType: 'Retail',
        virtualAccountNumber: '9988776655',
      },
    });
  }, 30000);

  afterAll(async () => {
    if (testBiz?.id) {
      await testDb.taxPayment.deleteMany({ where: { businessId: testBiz.id } });
      await testDb.monthlyTaxReport.deleteMany({ where: { businessId: testBiz.id } });
      await testDb.auditLog.deleteMany({ where: { businessId: testBiz.id } });
      await testDb.salesTransaction.deleteMany({ where: { businessId: testBiz.id } });
      await testDb.business.deleteMany({ where: { id: testBiz.id } });
    }
    if (testUser?.id) {
      await testDb.user.deleteMany({ where: { id: testUser.id } });
    }
    await testDb.$disconnect();
  }, 30000);

  beforeEach(() => {
    eventBus.removeAllListeners();
  });

  describe('1. Prefix-based Webhook Routing (ORD-*)', () => {
    test('Paystack charge.success with ORD-* prefix emits order.payment_confirmed and returns without error', async () => {
      const orderEvents: Array<AppDomainEvents['order.payment_confirmed']> = [];
      eventBus.on('order.payment_confirmed', (payload) => {
        orderEvents.push(payload);
      });

      const orderRef = `ORD-2026-${Math.floor(10000 + Math.random() * 90000)}`;
      const payload = {
        event: 'charge.success',
        data: {
          id: 99112233,
          reference: orderRef,
          amount: 3500000, // 35,000 NGN in kobo
          paid_at: new Date().toISOString(),
          channel: 'card',
          gateway_response: 'Successful',
          customer: {
            first_name: 'Folake',
            last_name: 'Adeyemi',
            phone: '08033221100',
            email: 'folake@example.com',
          },
          metadata: {
            orderId: 'ord_mock_123',
            storeId: 'store_mock_456',
            businessId: testBiz.id,
            userId: testUser.id,
            items: [
              { name: 'Beaded Necklace', quantity: 2, unitPrice: 15000 },
              { name: 'Gift Wrapping', quantity: 1, unitPrice: 5000 },
            ],
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha512', config.paystack.webhookSecret)
        .update(rawBody)
        .digest('hex');

      // Process the webhook
      await processWebhook(signature, rawBody);

      // Verify domain event was emitted with normalized payload
      expect(orderEvents).toHaveLength(1);
      const emitted = orderEvents[0];
      expect(emitted.orderId).toBe('ord_mock_123');
      expect(emitted.storeId).toBe('store_mock_456');
      expect(emitted.businessId).toBe(testBiz.id);
      expect(emitted.userId).toBe(testUser.id);
      expect(emitted.amount).toBe(35000); // Converted from kobo
      expect(emitted.orderNumber).toBe(orderRef);
      expect(emitted.customerName).toBe('Folake Adeyemi');
      expect(emitted.customerPhone).toBe('08033221100');
      expect(emitted.items).toHaveLength(2);

      // Verify audit log was recorded (allow brief async queue flush)
      let auditLog: any = null;
      for (let i = 0; i < 10; i++) {
        auditLog = await testDb.auditLog.findFirst({
          where: {
            action: 'store.order_payment_received',
            resourceId: 'ord_mock_123',
          },
        });
        if (auditLog) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(auditLog).not.toBeNull();
      expect(auditLog!.businessId).toBe(testBiz.id);
    });

    test('Storefront order refund (charge.refunded with ORD-*) is acknowledged cleanly without error', async () => {
      const orderRef = `ORD-2026-${Math.floor(10000 + Math.random() * 90000)}`;
      const payload = {
        event: 'charge.refunded',
        data: {
          reference: orderRef,
          amount: 3500000,
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha512', config.paystack.webhookSecret)
        .update(rawBody)
        .digest('hex');

      await expect(processWebhook(signature, rawBody)).resolves.not.toThrow();
    });
  });

  describe('2. DVA Double-Booking Guard for Storefront Orders', () => {
    test('processDVATransferWebhook returns false and skips generic auto-capture when reference starts with ORD-*', async () => {
      const orderRef = `ORD-2026-${Math.floor(10000 + Math.random() * 90000)}`;
      const dvaEvent = {
        event: 'charge.success',
        data: {
          reference: orderRef,
          amount: 5000000, // 50,000 NGN
          channel: 'dedicated_nuban',
          authorization: {
            receiver_bank_account_number: '9988776655',
          },
        },
      };

      // Direct call to processDVATransferWebhook must return false
      const result = await processDVATransferWebhook(dvaEvent);
      expect(result).toBe(false);

      // Ensure no generic salesTransaction was recorded with this reference
      const sale = await testDb.salesTransaction.findFirst({
        where: { referenceId: orderRef },
      });
      expect(sale).toBeNull();
    });

    test('Full webhook pipeline: dedicated_nuban payment for ORD-* routes to store order event instead of generic DVA sale', async () => {
      const orderEvents: Array<AppDomainEvents['order.payment_confirmed']> = [];
      eventBus.on('order.payment_confirmed', (payload) => {
        orderEvents.push(payload);
      });

      const orderRef = `ORD-2026-${Math.floor(10000 + Math.random() * 90000)}`;
      const payload = {
        event: 'charge.success',
        data: {
          reference: orderRef,
          amount: 1800000, // 18,000 NGN
          channel: 'dedicated_nuban',
          authorization: {
            receiver_bank_account_number: '9988776655',
          },
          customer: {
            first_name: 'Kayode',
            last_name: 'Balogun',
            phone: '08123456789',
          },
          metadata: {
            orderId: 'ord_dva_999',
            storeId: 'store_dva_111',
            businessId: testBiz.id,
            userId: testUser.id,
            items: [{ name: 'Custom Pottery Mug', quantity: 3, unitPrice: 6000 }],
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha512', config.paystack.webhookSecret)
        .update(rawBody)
        .digest('hex');

      await processWebhook(signature, rawBody);

      // Verify it emitted the store event
      expect(orderEvents).toHaveLength(1);
      expect(orderEvents[0].orderNumber).toBe(orderRef);
      expect(orderEvents[0].amount).toBe(18000);

      // Verify generic sales transaction was NOT created (preventing double-booking)
      const genericSale = await testDb.salesTransaction.findFirst({
        where: { referenceId: orderRef },
      });
      expect(genericSale).toBeNull();
    });
  });

  describe('3. Tax Payment Non-Interference', () => {
    test('Tax payments with PMT-* or other references continue uninterrupted without colliding with ORD-* logic', async () => {
      // Create a test monthly report and tax payment
      const report = await testDb.monthlyTaxReport.create({
        data: {
          businessId: testBiz.id,
          taxMonth: new Date('2026-04-01T00:00:00.000Z'),
          totalSales: 100000,
          totalExpenses: 20000,
          grossProfit: 80000,
          taxRate: 7.5,
          taxPayable: 6000,
          profitMargin: 80,
          isFinalized: true,
          isLocked: false,
          paymentStatus: 'pending',
        },
      });

      const pmtRef = `PMT-${testBiz.id.substring(0, 6)}-${Date.now()}-mock`;
      const payment = await testDb.taxPayment.create({
        data: {
          taxReportId: report.id,
          businessId: testBiz.id,
          amountPaid: 6000,
          paymentStatus: 'pending',
          paymentMethod: 'card',
          transactionReference: pmtRef,
        },
      });

      const payload = {
        event: 'charge.success',
        data: {
          reference: pmtRef,
          amount: 600000, // 6,000 NGN in kobo
          paid_at: new Date().toISOString(),
          channel: 'card',
          gateway_response: 'Approved',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha512', config.paystack.webhookSecret)
        .update(rawBody)
        .digest('hex');

      await processWebhook(signature, rawBody);

      // Verify tax payment completed and report locked
      const updatedPayment = await testDb.taxPayment.findUnique({
        where: { id: payment.id },
      });
      expect(updatedPayment!.paymentStatus).toBe('completed');

      const updatedReport = await testDb.monthlyTaxReport.findUnique({
        where: { id: report.id },
      });
      expect(updatedReport!.paymentStatus).toBe('completed');
      expect(updatedReport!.isLocked).toBe(true);
    });
  });
});
