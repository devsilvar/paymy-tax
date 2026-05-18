/* eslint-disable */
import request from 'supertest';
import { createApp } from './../../src/app';
import type { Application } from 'express';

let app: Application;

// ── Shared state across sequential tests ──
let accessToken = '';
let refreshToken = '';
let userId = '';
let businessId = '';
let saleIds: string[] = [];
let expenseIds: string[] = [];
let taxReportId = '';
let reminderId = '';
let adminToken = '';
let secondBusinessId = '';
let paymentId = '';

const TEST_EMAIL = `test-${Date.now()}@e2e.com`;
const TEST_PASSWORD = 'TestPass@123';
const CHANGED_PASSWORD = 'NewPass@1234';
const now = new Date();
const MONTH = now.getMonth() + 1;
const YEAR = now.getFullYear();

const auth = () => ({ Authorization: `Bearer ${accessToken}` });
const adminAuth = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(() => {
  app = createApp();
});

describe('PayMyTax E2E', () => {
  // ═══════════════════════════════════════
  // HEALTH CHECK
  // ═══════════════════════════════════════
  describe('Health Check', () => {
    it('GET /api/health → 200', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: expect.any(String),
        service: expect.any(String),
      });
    });

    it('GET /api/health/detailed → 200 + db connected', async () => {
      const res = await request(app).get('/api/health/detailed');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('checks');
      expect(res.body.checks).toHaveProperty('database');
    });
  });

  // ═══════════════════════════════════════
  // AUTH - Happy path first (before rate limiter triggers)
  // ═══════════════════════════════════════
  describe('Auth', () => {
    it('POST register → 201 + tokens + user', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');
      expect(res.body.data.accessToken).toEqual(expect.any(String));

      accessToken = res.body.data.accessToken;
      refreshToken = res.body.data.refreshToken;
      userId = res.body.data.user?.id ?? res.body.data.userId ?? '';
    });

    it('POST login → 200 + tokens', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');

      accessToken = res.body.data.accessToken;
      refreshToken = res.body.data.refreshToken;
    });

    it('POST refresh → 200 + new access token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('accessToken');
      accessToken = res.body.data.accessToken;
    });

    it('GET /auth/me → 200 + user profile', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('email', TEST_EMAIL);
      if (res.body.data.id) userId = res.body.data.id;
    });

    it('GET /auth/me (no token) → 401', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('PUT change-password → 200', async () => {
      const res = await request(app)
        .put('/api/v1/auth/change-password')
        .set(auth())
        .send({ currentPassword: TEST_PASSWORD, newPassword: CHANGED_PASSWORD });
      expect(res.status).toBe(200);
    });

    it('POST login with new password → 200', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: TEST_EMAIL, password: CHANGED_PASSWORD });
      expect(res.status).toBe(200);
      accessToken = res.body.data.accessToken;
      refreshToken = res.body.data.refreshToken;
    });

    it('PUT change-password (wrong current) → 401', async () => {
      const res = await request(app)
        .put('/api/v1/auth/change-password')
        .set(auth())
        .send({ currentPassword: 'WrongCurrent@1', newPassword: 'Anything@123' });
      expect(res.status).toBe(401);
    });

    it('POST forgot-password → 200', async () => {
      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: TEST_EMAIL });
      expect([200, 429]).toContain(res.status);
    });

    it('POST refresh (invalid token) → 401', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid.token.here' });
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════
  // ADMIN LOGIN - Before rate limiter burns out
  // ═══════════════════════════════════════
  describe('Admin Login', () => {
    it('Login as admin → 200 + admin token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@paymytax.com', password: 'Admin@123456' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('accessToken');
      adminToken = res.body.data.accessToken;
    });
  });

  // ═══════════════════════════════════════
  // AUTH ERROR CASES - Rate limiter may kick in here
  // ═══════════════════════════════════════
  describe('Auth Error Cases', () => {
    it('POST register (duplicate email) → 409', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: TEST_EMAIL, password: CHANGED_PASSWORD });
      expect(res.status).toBe(409);
    });

    it('POST register (weak password) → validation error', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'weak@e2e.com', password: '123' });
      expect([400, 429, 500]).toContain(res.status);
    });

    it('POST register (invalid email) → validation error', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: CHANGED_PASSWORD });
      expect([400, 429, 500]).toContain(res.status);
    });

    it('POST login (wrong password) → 401 or 429', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: TEST_EMAIL, password: 'WrongPass@999' });
      expect([401, 429]).toContain(res.status);
    });

    it('POST login (non-existent user) → 401 or 429', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@nowhere.com', password: CHANGED_PASSWORD });
      expect([401, 429]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════
  // BUSINESS - CRUD + Authorization
  // ═══════════════════════════════════════
  describe('Business', () => {
    it('POST /businesses → 201', async () => {
      const res = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({
          businessName: 'E2E Test Biz',
          ownerName: 'Test Owner',
          businessType: 'retail',
          address: '123 Test Street',
          city: 'Lagos',
          state: 'Lagos',
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.businessName).toBe('E2E Test Biz');
      businessId = res.body.data.id;
    });

    it('POST /businesses (second) → 201', async () => {
      const res = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({
          businessName: 'Second Biz',
          ownerName: 'Test Owner',
          businessType: 'technology',
        });

      expect(res.status).toBe(201);
      secondBusinessId = res.body.data.id;
    });

    it('POST /businesses (missing required fields) → validation error', async () => {
      const res = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({ businessName: 'X' });
      expect([400, 500]).toContain(res.status);
    });

    it('POST /businesses (no auth) → 401', async () => {
      const res = await request(app)
        .post('/api/v1/businesses')
        .send({ businessName: 'No Auth', ownerName: 'X', businessType: 'Y' });
      expect(res.status).toBe(401);
    });

    it('GET /businesses → 200 + pagination', async () => {
      const res = await request(app)
        .get('/api/v1/businesses')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('GET /businesses/:id → 200 + correct data', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(businessId);
      expect(res.body.data.businessName).toBe('E2E Test Biz');
    });

    it('PUT /businesses/:id → 200 + updated', async () => {
      const res = await request(app)
        .put(`/api/v1/businesses/${businessId}`)
        .set(auth())
        .send({ businessName: 'E2E Updated Biz', city: 'Abuja' });

      expect(res.status).toBe(200);
      expect(res.body.data.businessName).toBe('E2E Updated Biz');
    });

    it('GET /businesses/:id (non-existent) → 403 or 404', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .get(`/api/v1/businesses/${fakeId}`)
        .set(auth());
      expect([403, 404]).toContain(res.status);
    });

    it('DELETE /businesses/:id (second) → 200', async () => {
      const res = await request(app)
        .delete(`/api/v1/businesses/${secondBusinessId}`)
        .set(auth());
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════
  // SALES - Full CRUD
  // ═══════════════════════════════════════
  describe('Sales', () => {
    const salesPath = () => `/api/v1/businesses/${businessId}/sales`;

    it('POST sale 1 (manual) → 201', async () => {
      const res = await request(app)
        .post(salesPath())
        .set(auth())
        .send({
          amount: 1000,
          source: 'manual',
          transactionDate: new Date().toISOString(),
          description: 'E2E sale 1',
          customerName: 'Customer 1',
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty('id');
      expect(Number(res.body.data.amount)).toBe(1000);
      saleIds.push(res.body.data.id);
    });

    it('POST sale 2 (pos) → 201', async () => {
      const res = await request(app)
        .post(salesPath())
        .set(auth())
        .send({
          amount: 2000,
          source: 'pos',
          transactionDate: new Date().toISOString(),
          description: 'E2E sale 2',
        });

      expect(res.status).toBe(201);
      expect(Number(res.body.data.amount)).toBe(2000);
      saleIds.push(res.body.data.id);
    });

    it('POST sale 3 (bank_transfer) → 201', async () => {
      const res = await request(app)
        .post(salesPath())
        .set(auth())
        .send({
          amount: 3000,
          source: 'bank_transfer',
          transactionDate: new Date().toISOString(),
          description: 'E2E sale 3',
        });

      expect(res.status).toBe(201);
      saleIds.push(res.body.data.id);
    });

    it('POST sales (invalid source) → validation error', async () => {
      const res = await request(app)
        .post(salesPath())
        .set(auth())
        .send({
          amount: 100,
          source: 'invalid_source',
          transactionDate: new Date().toISOString(),
        });
      expect([400, 500]).toContain(res.status);
    });

    it('POST sales (negative amount) → validation error', async () => {
      const res = await request(app)
        .post(salesPath())
        .set(auth())
        .send({
          amount: -500,
          source: 'manual',
          transactionDate: new Date().toISOString(),
        });
      expect([400, 500]).toContain(res.status);
    });

    it('GET sales → 200 + list', async () => {
      const res = await request(app)
        .get(salesPath())
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('GET sales/:id → 200 + correct sale', async () => {
      const res = await request(app)
        .get(`${salesPath()}/${saleIds[0]}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(saleIds[0]);
    });

    it('GET sales/:id (non-existent) → 403 or 404', async () => {
      const res = await request(app)
        .get(`${salesPath()}/00000000-0000-0000-0000-000000000000`)
        .set(auth());
      expect([403, 404]).toContain(res.status);
    });

    it('GET sales/summary → 200', async () => {
      const res = await request(app)
        .get(`${salesPath()}/summary`)
        .query({ month: MONTH, year: YEAR })
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('PUT sales/:id → 200 + updated', async () => {
      const res = await request(app)
        .put(`${salesPath()}/${saleIds[0]}`)
        .set(auth())
        .send({ amount: 9999, description: 'Updated sale' });

      expect(res.status).toBe(200);
      expect(Number(res.body.data.amount)).toBe(9999);
    });

    it('DELETE sales/:id → 200', async () => {
      const res = await request(app)
        .delete(`${salesPath()}/${saleIds[2]}`)
        .set(auth());
      expect(res.status).toBe(200);
      saleIds.pop();
    });
  });

  // ═══════════════════════════════════════
  // EXPENSES - Full CRUD
  // ═══════════════════════════════════════
  describe('Expenses', () => {
    const expensesPath = () => `/api/v1/businesses/${businessId}/expenses`;

    it('POST expense 1 (rent) → 201', async () => {
      const res = await request(app)
        .post(expensesPath())
        .set(auth())
        .send({
          amount: 500,
          category: 'rent',
          description: 'E2E expense 1',
          expenseDate: new Date().toISOString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty('id');
      expect(Number(res.body.data.amount)).toBe(500);
      expenseIds.push(res.body.data.id);
    });

    it('POST expense 2 (salary) → 201', async () => {
      const res = await request(app)
        .post(expensesPath())
        .set(auth())
        .send({
          amount: 1000,
          category: 'salary',
          description: 'E2E expense 2',
          expenseDate: new Date().toISOString(),
        });

      expect(res.status).toBe(201);
      expenseIds.push(res.body.data.id);
    });

    it('POST expense 3 (utility) → 201', async () => {
      const res = await request(app)
        .post(expensesPath())
        .set(auth())
        .send({
          amount: 1500,
          category: 'utility',
          description: 'E2E expense 3',
          expenseDate: new Date().toISOString(),
        });

      expect(res.status).toBe(201);
      expenseIds.push(res.body.data.id);
    });

    it('POST expenses (invalid category) → validation error', async () => {
      const res = await request(app)
        .post(expensesPath())
        .set(auth())
        .send({
          amount: 100,
          category: 'invalid_category',
          description: 'Bad category',
          expenseDate: new Date().toISOString(),
        });
      expect([400, 500]).toContain(res.status);
    });

    it('POST expenses (negative amount) → validation error', async () => {
      const res = await request(app)
        .post(expensesPath())
        .set(auth())
        .send({
          amount: -100,
          category: 'rent',
          description: 'Negative',
          expenseDate: new Date().toISOString(),
        });
      expect([400, 500]).toContain(res.status);
    });

    it('GET expenses → 200 + list', async () => {
      const res = await request(app)
        .get(expensesPath())
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('GET expenses/:id → 200 + correct expense', async () => {
      const res = await request(app)
        .get(`${expensesPath()}/${expenseIds[0]}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(expenseIds[0]);
    });

    it('GET expenses/:id (non-existent) → 403 or 404', async () => {
      const res = await request(app)
        .get(`${expensesPath()}/00000000-0000-0000-0000-000000000000`)
        .set(auth());
      expect([403, 404]).toContain(res.status);
    });

    it('GET expenses/summary → 200', async () => {
      const res = await request(app)
        .get(`${expensesPath()}/summary`)
        .query({ month: MONTH, year: YEAR })
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('PUT expenses/:id → 200 + updated', async () => {
      const res = await request(app)
        .put(`${expensesPath()}/${expenseIds[0]}`)
        .set(auth())
        .send({ amount: 7777, description: 'Updated expense' });

      expect(res.status).toBe(200);
      expect(Number(res.body.data.amount)).toBe(7777);
    });

    it('DELETE expenses/:id → 200', async () => {
      const res = await request(app)
        .delete(`${expensesPath()}/${expenseIds[2]}`)
        .set(auth());
      expect(res.status).toBe(200);
      expenseIds.pop();
    });
  });

  // ═══════════════════════════════════════
  // TAX - Calculate, Reports, Finalize/Lock
  // ═══════════════════════════════════════
  describe('Tax', () => {
    const taxPath = () => `/api/v1/businesses/${businessId}/tax`;

    it('POST tax/calculate → 200 or 201 + report', async () => {
      const res = await request(app)
        .post(`${taxPath()}/calculate`)
        .set(auth())
        .send({ month: MONTH, year: YEAR });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toHaveProperty('id');
      taxReportId = res.body.data.id;
    });

    it('POST tax/calculate (invalid month 13) → validation error', async () => {
      const res = await request(app)
        .post(`${taxPath()}/calculate`)
        .set(auth())
        .send({ month: 13, year: YEAR });
      expect([400, 500]).toContain(res.status);
    });

    it('POST tax/calculate (invalid year 1999) → validation error', async () => {
      const res = await request(app)
        .post(`${taxPath()}/calculate`)
        .set(auth())
        .send({ month: MONTH, year: 1999 });
      expect([400, 500]).toContain(res.status);
    });

    it('GET tax/reports → 200 + list', async () => {
      const res = await request(app)
        .get(`${taxPath()}/reports`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('GET tax/reports/:id → 200 + correct report', async () => {
      const res = await request(app)
        .get(`${taxPath()}/reports/${taxReportId}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(taxReportId);
    });

    it('GET tax/dashboard → 200', async () => {
      const res = await request(app)
        .get(`${taxPath()}/dashboard`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('GET tax/analytics → 200 + shape', async () => {
      const res = await request(app)
        .get(`${taxPath()}/analytics?range=12m`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.kpis).toBeDefined();
      expect(Array.isArray(res.body.data.series)).toBe(true);
      expect(res.body.data.statusDistribution).toBeDefined();
    });

    it('POST tax/reports/:id/finalize → 200', async () => {
      const res = await request(app)
        .post(`${taxPath()}/reports/${taxReportId}/finalize`)
        .set(auth());
      expect(res.status).toBe(200);
    });

    it('POST sale in finalized period → 423 (locked)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/sales`)
        .set(auth())
        .send({
          amount: 100,
          source: 'manual',
          transactionDate: new Date(YEAR, MONTH - 1, 15).toISOString(),
          description: 'Should be locked',
        });
      expect(res.status).toBe(423);
    });

    it('POST tax/reports/:id/unfinalize → 200', async () => {
      const res = await request(app)
        .post(`${taxPath()}/reports/${taxReportId}/unfinalize`)
        .set(auth());
      expect(res.status).toBe(200);
    });

    it('POST sale after unfinalize → 201 (unlocked)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/sales`)
        .set(auth())
        .send({
          amount: 100,
          source: 'manual',
          transactionDate: new Date(YEAR, MONTH - 1, 15).toISOString(),
          description: 'After unfinalize',
        });
      expect(res.status).toBe(201);
    });
  });

  // ═══════════════════════════════════════
  // PAYMENTS - Initiate, List, Get, Verify, Webhook
  // ═══════════════════════════════════════
  describe('Payments', () => {
    const taxPath = () => `/api/v1/businesses/${businessId}/tax`;

    // Re-finalize the report so we can test payment
    it('POST tax/reports/:id/finalize (for payment) → 200', async () => {
      const res = await request(app)
        .post(`${taxPath()}/reports/${taxReportId}/finalize`)
        .set(auth());
      expect(res.status).toBe(200);
    });

    it('POST /tax/pay (no auth) → 401', async () => {
      const res = await request(app)
        .post(`${taxPath()}/pay`)
        .send({ taxReportId });
      expect(res.status).toBe(401);
    });

    it('POST /tax/pay (missing taxReportId) → 400 or 500', async () => {
      const res = await request(app)
        .post(`${taxPath()}/pay`)
        .set(auth())
        .send({});
      expect([400, 500]).toContain(res.status);
    });

    it('POST /tax/pay (invalid taxReportId) → 400 or 500', async () => {
      const res = await request(app)
        .post(`${taxPath()}/pay`)
        .set(auth())
        .send({ taxReportId: 'not-a-uuid' });
      expect([400, 500]).toContain(res.status);
    });

    it('POST /tax/pay (non-existent report) → 404', async () => {
      const res = await request(app)
        .post(`${taxPath()}/pay`)
        .set(auth())
        .send({ taxReportId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
    });

    it('POST /tax/pay (finalized report) → 200 or 500 (depends on Paystack keys)', async () => {
      const res = await request(app)
        .post(`${taxPath()}/pay`)
        .set(auth())
        .send({ taxReportId });

      // With valid Paystack test keys → 200 with authorizationUrl
      // Without keys → 500 (Paystack API rejects)
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveProperty('authorizationUrl');
        expect(res.body.data).toHaveProperty('reference');
        expect(res.body.data).toHaveProperty('paymentId');
        paymentId = res.body.data.paymentId;
      } else {
        expect([500, 429]).toContain(res.status);
      }
    });

    it('GET /tax/payments → 200 + list', async () => {
      const res = await request(app)
        .get(`${taxPath()}/payments`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
      expect(Array.isArray(res.body.data)).toBe(true);

      // If payment was created, capture paymentId
      if (res.body.data.length > 0 && !paymentId) {
        paymentId = res.body.data[0].id;
      }
    });

    it('GET /tax/payments (no auth) → 401', async () => {
      const res = await request(app)
        .get(`${taxPath()}/payments`);
      expect(res.status).toBe(401);
    });

    it('GET /tax/payments?status=pending → 200 + filtered', async () => {
      const res = await request(app)
        .get(`${taxPath()}/payments`)
        .query({ status: 'pending' })
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /tax/payments/:id → 200 (if payment exists)', async () => {
      if (!paymentId) return;
      const res = await request(app)
        .get(`${taxPath()}/payments/${paymentId}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(paymentId);
    });

    it('GET /tax/payments/:id (non-existent) → 404', async () => {
      const res = await request(app)
        .get(`${taxPath()}/payments/00000000-0000-0000-0000-000000000000`)
        .set(auth());
      expect(res.status).toBe(404);
    });

    it('GET /tax/payments/:id/verify (if payment exists) → 200 or 500', async () => {
      if (!paymentId) return;
      const res = await request(app)
        .get(`${taxPath()}/payments/${paymentId}/verify`)
        .set(auth());

      // 200 if Paystack keys are valid, 500 if not
      expect([200, 500]).toContain(res.status);
    });

    it('POST /webhooks/paystack (no signature) → 400', async () => {
      const res = await request(app)
        .post('/api/webhooks/paystack')
        .send({ event: 'charge.success', data: {} });
      expect(res.status).toBe(400);
    });

    it('POST /webhooks/paystack (invalid signature) → 401', async () => {
      const res = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', 'invalid-signature')
        .send({ event: 'charge.success', data: { reference: 'test' } });
      expect(res.status).toBe(401);
    });

    // Unfinalize for subsequent tests
    it('POST tax/reports/:id/unfinalize (after payment tests) → 200', async () => {
      // Only unfinalize if report isn't locked (payment wasn't completed)
      const res = await request(app)
        .post(`${taxPath()}/reports/${taxReportId}/unfinalize`)
        .set(auth());
      expect([200, 423]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════
  // REMINDERS - Generate, List, Mark, Dismiss
  // ═══════════════════════════════════════
  describe('Reminders', () => {
    const remindersPath = () => `/api/v1/businesses/${businessId}/reminders`;

    it('POST reminders/generate → 200 or 201', async () => {
      const res = await request(app)
        .post(`${remindersPath()}/generate`)
        .set(auth())
        .send({ month: MONTH, year: YEAR });
      expect([200, 201]).toContain(res.status);
    });

    it('POST reminders/generate (duplicate) → 200 (idempotent)', async () => {
      const res = await request(app)
        .post(`${remindersPath()}/generate`)
        .set(auth())
        .send({ month: MONTH, year: YEAR });
      expect([200, 201]).toContain(res.status);
    });

    it('GET reminders → 200 + list', async () => {
      const res = await request(app)
        .get(remindersPath())
        .set(auth());

      expect(res.status).toBe(200);
      const reminders = res.body.data;
      if (Array.isArray(reminders) && reminders.length > 0) {
        reminderId = reminders[0].id;
      }
    });

    it('GET reminders/active → 200', async () => {
      const res = await request(app)
        .get(`${remindersPath()}/active`)
        .set(auth());
      expect(res.status).toBe(200);
    });

    it('PATCH reminders/:id/mark-sent → 200', async () => {
      if (!reminderId) return;
      const res = await request(app)
        .patch(`${remindersPath()}/${reminderId}/mark-sent`)
        .set(auth());
      expect(res.status).toBe(200);
    });

    it('DELETE reminders/:id → 200', async () => {
      if (!reminderId) return;
      const res = await request(app)
        .delete(`${remindersPath()}/${reminderId}`)
        .set(auth());
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════
  // ADMIN - Dashboard, Users, Businesses
  // ═══════════════════════════════════════
  describe('Admin', () => {
    it('GET /admin/dashboard → 200', async () => {
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('GET /admin/dashboard (regular user) → 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set(auth());
      expect(res.status).toBe(403);
    });

    it('GET /admin/users → 200 + list', async () => {
      const res = await request(app)
        .get('/api/v1/admin/users')
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('GET /admin/users/:id → 200 + user details', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/users/${userId}`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('email');
    });

    it('PATCH /admin/users/:id/status (deactivate) → 200', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${userId}/status`)
        .set(adminAuth())
        .send({ isActive: false });
      expect(res.status).toBe(200);
    });

    it('Deactivated user existing session still works (JWT valid)', async () => {
      // Auth middleware only checks JWT, not isActive flag per-request
      const res = await request(app)
        .get('/api/v1/businesses')
        .set(auth());
      expect(res.status).toBe(200);
    });

    it('PATCH /admin/users/:id/status (reactivate) → 200', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${userId}/status`)
        .set(adminAuth())
        .send({ isActive: true });
      expect(res.status).toBe(200);
    });

    it('GET /admin/businesses → 200', async () => {
      const res = await request(app)
        .get('/api/v1/admin/businesses')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('GET /admin/audit-logs → 200', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set(adminAuth());
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════
  describe('Cleanup', () => {
    it('DELETE /businesses/:id → 200', async () => {
      const res = await request(app)
        .delete(`/api/v1/businesses/${businessId}`)
        .set(auth());
      expect(res.status).toBe(200);
    });
  });
});
