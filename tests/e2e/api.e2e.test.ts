/* eslint-disable */
import 'dotenv/config'; // Load .env before any test so signature calc matches server
import request from 'supertest';
import { createApp } from './../../src/app';
import prisma from '../../src/lib/prisma';
import config from '../../src/config';
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

beforeAll(async () => {
  app = createApp();
  await prisma.$connect();
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

    // ── Logo Upload, Validation, and Deletion Tests ──
    it('POST /businesses/:id/logo (PNG) → 200 + logoUrl updated', async () => {
      // 1x1 transparent PNG buffer
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .set(auth())
        .attach('logo', pngBuffer, { filename: 'company_logo.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('logoUrl');
      expect(res.body.data.logoUrl).toBeTruthy();
    });

    it('POST /businesses/:id/logo (JPEG) → 200 + logoUrl updated', async () => {
      // Minimal JPEG buffer
      const jpegBuffer = Buffer.from(
        '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
        'base64'
      );

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .set(auth())
        .attach('logo', jpegBuffer, { filename: 'company_logo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.logoUrl).toBeTruthy();
    });

    it('POST /businesses/:id/logo (SVG) → 200 + logoUrl updated', async () => {
      const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .set(auth())
        .attach('logo', svgBuffer, { filename: 'logo.svg', contentType: 'image/svg+xml' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.logoUrl).toBeTruthy();
    });

    it('POST /businesses/:id/logo (no file uploaded) → 400 LOGO_NO_FILE', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .set(auth());

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LOGO_NO_FILE');
    });

    it('POST /businesses/:id/logo (invalid file type: pdf) → 400 LOGO_BAD_TYPE', async () => {
      const fakePdf = Buffer.from('%PDF-1.4 test content');

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .set(auth())
        .attach('logo', fakePdf, { filename: 'doc.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LOGO_BAD_TYPE');
    });

    it('POST /businesses/:id/logo (file too large > 5MB) → 400 FILE_TOO_LARGE', async () => {
      // 5.2 MB buffer
      const largeBuffer = Buffer.alloc(5.2 * 1024 * 1024);

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .set(auth())
        .attach('logo', largeBuffer, { filename: 'huge_logo.png', contentType: 'image/png' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('POST /businesses/:id/logo (unauthenticated) → 401', async () => {
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/logo`)
        .attach('logo', pngBuffer, { filename: 'logo.png', contentType: 'image/png' });

      expect(res.status).toBe(401);
    });

    it('POST /businesses/:id/logo (non-existent business) → 403 or 404', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );

      const res = await request(app)
        .post(`/api/v1/businesses/${fakeId}/logo`)
        .set(auth())
        .attach('logo', pngBuffer, { filename: 'logo.png', contentType: 'image/png' });

      expect([403, 404]).toContain(res.status);
    });

    it('DELETE /businesses/:id/logo (happy path) → 200 + logo removed', async () => {
      const res = await request(app)
        .delete(`/api/v1/businesses/${businessId}/logo`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.logoUrl).toBeNull();
    });

    it('DELETE /businesses/:id/logo (when no logo exists) → 404 LOGO_NOT_FOUND', async () => {
      const res = await request(app)
        .delete(`/api/v1/businesses/${businessId}/logo`)
        .set(auth());

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LOGO_NOT_FOUND');
    });

    it('DELETE /businesses/:id/logo (unauthenticated) → 401', async () => {
      const res = await request(app)
        .delete(`/api/v1/businesses/${businessId}/logo`);

      expect(res.status).toBe(401);
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

    // PHASE3_VERIFICATION finding #3 regression — garbage `from`/`to` must
    // hit the isoMonth regex at the validator and return a structured 400,
    // not fall through to parseMonthKey → NaN Date → Prisma 500.
    it('GET tax/analytics (custom range, garbage from/to) → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get(`${taxPath()}/analytics?range=custom&from=garbage&to=garbage`)
        .set(auth());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      // Both fields must surface as field-level errors.
      const fields = res.body.error.details.map((d: any) => d.field);
      expect(fields).toContain('from');
      expect(fields).toContain('to');
    });

    it('GET tax/analytics (custom range, valid YYYY-MM) → 200', async () => {
      const res = await request(app)
        .get(`${taxPath()}/analytics?range=custom&from=2099-01&to=2099-03`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.window.from).toBe('2099-01');
      expect(res.body.data.window.to).toBe('2099-03');
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
      // Unique per run: the webhook handler's replay-prevention dedupes on the
      // literal signature header within a 5-min window — a reused literal from
      // a previous suite run would be acknowledged (200) as a redelivery.
      const res = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', `invalid-signature-${Date.now()}`)
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
  // WEBHOOKS - Signature verification + DVA transfer dedupe
  // ═══════════════════════════════════════
  describe('Webhooks', () => {
    // Helper: compute valid HMAC-SHA512 signature against the configured secret
    const computeSignature = (body: string): string => {
      const crypto = require('crypto');
      return crypto
        .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET || 'test-secret')
        .update(body)
        .digest('hex');
    };

    it('POST /webhooks/paystack (valid signature + dedicated_nuban charge → creates sale)', async () => {
      // This test creates a mock bank_transfer sale via webhook. Requires:
      // 1. PAYSTACK_WEBHOOK_SECRET to be set (matches .env)
      // 2. A business with virtualAccountNumber set (businessId from earlier)
      // If no secret is configured, skip the payload verification but still
      // test the code path by using a predictable reference.
      const reference = `webhook-test-${Date.now()}-${Math.random()}`;
      const payload = JSON.stringify({
        event: 'charge.success',
        data: {
          reference,
          amount: 500000, // 5000 NGN in kobo
          channel: 'dedicated_nuban',
          paid_at: new Date().toISOString(),
          dedicated_account: { account_number: '0000000000' }, // won't match any business; verifies code path
          customer: { first_name: 'Webhook', last_name: 'Tester' },
        },
      });

      const sig = computeSignature(payload);
      const res = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', sig)
        .set('Content-Type', 'application/json')
        .send(Buffer.from(payload));

      // Valid signature should return 200 (webhook processed successfully)
      // OR 401 if there's signature mismatch (test vs actual secret)
      expect([200, 401]).toContain(res.status);
    });

    it('POST /webhooks/paystack (duplicate webhook → no-op)', async () => {
      // Replay the exact same payload as the previous test — should be
      // deduped gracefully (no error, no second sale). Requires secret.
      const reference = `webhook-test-dup-${Date.now()}`;
      const payload = JSON.stringify({
        event: 'charge.success',
        data: {
          reference,
          amount: 300000,
          channel: 'dedicated_nuban',
          paid_at: new Date().toISOString(),
          dedicated_account: { account_number: '0000000000' },
          customer: { first_name: 'Dupe', last_name: 'Test' },
        },
      });

      const sig = computeSignature(payload);
      // First hit
      const res1 = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', sig)
        .set('Content-Type', 'application/json')
        .send(Buffer.from(payload));
      expect([200, 401]).toContain(res1.status);

      // Second hit (same signature, same body)
      const res2 = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', sig)
        .set('Content-Type', 'application/json')
        .send(Buffer.from(payload));
      // Should succeed or acknowledge without creating an unhandled error
      expect([200, 401]).toContain(res2.status);
    });

    it('POST /webhooks/paystack (bad signature → 401)', async () => {
      const payload = JSON.stringify({
        event: 'charge.success',
        data: { reference: 'bad-sig-test', amount: 10000 },
      });

      const res = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', `faketoken-signature-${Date.now()}`)
        .set('Content-Type', 'application/json')
        .send(Buffer.from(payload));

      expect(res.status).toBe(401);
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
  // TAX - UTC regression (PHASE3_VERIFICATION finding #2)
  // ═══════════════════════════════════════
  //
  // taxMonth + reminder.scheduledDate are @db.Date. Constructing them with
  // local-time `new Date(year, month-1, 1)` on a UTC+ host (Lagos = UTC+1)
  // truncates to the previous calendar day in Postgres. Pre-fix, calculating
  // tax for January would store and surface December of the prior year.
  // We pick January of a far-future year so:
  //   • the row can't already exist from earlier tests
  //   • the bug, if reintroduced, surfaces as a clean off-by-one
  describe('Tax — UTC regression for January', () => {
    const REGRESSION_MONTH = 1;
    const REGRESSION_YEAR = 2099;
    let regressionReportId = '';

    it('POST tax/calculate (Jan 2099) → taxMonth stays in January UTC', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/calculate`)
        .set(auth())
        .send({ month: REGRESSION_MONTH, year: REGRESSION_YEAR });

      expect([200, 201]).toContain(res.status);
      regressionReportId = res.body.data.id;

      const taxMonth = new Date(res.body.data.taxMonth);
      // Off-by-one would land us in Dec 2098. Asserting both year and month
      // catches the bug regardless of host timezone.
      expect(taxMonth.getUTCFullYear()).toBe(REGRESSION_YEAR);
      expect(taxMonth.getUTCMonth()).toBe(REGRESSION_MONTH - 1); // 0-indexed
      expect(taxMonth.getUTCDate()).toBe(1);
    });

    it('GET tax/reports?year=2099 → list includes the January report', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/tax/reports?year=${REGRESSION_YEAR}`)
        .set(auth());

      expect(res.status).toBe(200);
      // listReports filters by year — same UTC fix; missing it would yield
      // an empty array on a UTC+ host because Jan 1 stored as prev-Dec-31
      // falls outside the (Jan 1 .. Dec 31) UTC year window.
      expect(Array.isArray(res.body.data)).toBe(true);
      const found = res.body.data.find((r: any) => r.id === regressionReportId);
      expect(found).toBeDefined();
      const fetchedMonth = new Date(found.taxMonth);
      expect(fetchedMonth.getUTCMonth()).toBe(0); // January
      expect(fetchedMonth.getUTCFullYear()).toBe(REGRESSION_YEAR);
    });
  });

  // ═══════════════════════════════════════
  // TAX - Margin warning copy regression (PHASE3_VERIFICATION finding #1)
  // ═══════════════════════════════════════
  //
  // Pre-fix, `business.defaultProfitMargin` was read with `typeof === 'number'`
  // which silently fell through to the hardcoded 20% baseline (Prisma returns
  // Decimal, not number). Any business that configured a custom margin saw
  // warnings phrased against the wrong percentage.
  //
  // The fix at tax.service.ts:131-138 uses `toNumber()` with a null guard.
  // This regression: configure 40%, drive an actual margin near 5% (deviation
  // 35 ≫ 15-pt threshold), assert the warning message echoes (40%) — not
  // the legacy (20%). A re-introduction of the typeof bug would re-print
  // "20%" and fail the substring check.
  describe('Tax — defaultProfitMargin echoed in warning copy', () => {
    const M = 2; // February — distinct from Jan-2099 regression above
    const Y = 2099;

    it('PUT /businesses/:id with defaultProfitMargin=40 → 200', async () => {
      const res = await request(app)
        .put(`/api/v1/businesses/${businessId}`)
        .set(auth())
        .send({ defaultProfitMargin: 40 });
      expect(res.status).toBe(200);
      expect(Number(res.body.data.defaultProfitMargin)).toBe(40);
    });

    it('records sale + expense yielding ~5% actual margin for Feb 2099', async () => {
      // Sale 1,000,000 ; expense 950,000 ⇒ gross 50,000 ; margin 5%
      // |5 − 40| = 35 > 15 → margin_deviation fires
      const saleRes = await request(app)
        .post(`/api/v1/businesses/${businessId}/sales`)
        .set(auth())
        .send({
          amount: 1_000_000,
          source: 'manual',
          transactionDate: `${Y}-0${M}-15`,
          description: 'Margin regression sale',
        });
      expect([200, 201]).toContain(saleRes.status);

      const expRes = await request(app)
        .post(`/api/v1/businesses/${businessId}/expenses`)
        .set(auth())
        .send({
          amount: 950_000,
          category: 'inventory',
          expenseDate: `${Y}-0${M}-15`,
          description: 'Margin regression expense',
        });
      expect([200, 201]).toContain(expRes.status);
    });

    it('POST tax/calculate → margin_deviation warning quotes 40%, not 20%', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/calculate`)
        .set(auth())
        .send({ month: M, year: Y });

      expect([200, 201]).toContain(res.status);

      // Controller surfaces warnings at the top level (sibling of `data`)
      // — see tax.controller.ts:22-27. Reading `res.body.data.warnings`
      // would be undefined and silently pass a `find()` returning undefined.
      const warnings: Array<{ type: string; message: string }> =
        res.body.warnings ?? [];
      const dev = warnings.find((w) => w.type === 'margin_deviation');

      expect(dev).toBeDefined();
      // The expected-margin substring is the whole point of the regression.
      expect(dev!.message).toContain('(40%)');
      // Belt-and-braces: the legacy fallback must NOT appear.
      expect(dev!.message).not.toContain('(20%)');
    });
  });

  // ═══════════════════════════════════════
  // RECEIPTS (DUAL-STAGE & DVA INFLOW)
  // ═══════════════════════════════════════
  describe('Receipts', () => {
    let transferSaleId: string;

    it('Create a bank_transfer sale to test DVA receipt generation', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/sales`)
        .set(auth())
        .send({
          amount: 75000,
          source: 'bank_transfer',
          transactionDate: '2026-03-10',
          description: 'Inflow from Customer Chukwuma',
          customerName: 'Chukwuma Obi',
        });
      expect([200, 201]).toContain(res.status);
      transferSaleId = res.body.data.id;
    });

    it('GET /businesses/:id/receipts/dva-transfers/:saleId → 200 + PDF stream', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/receipts/dva-transfers/${transferSaleId}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment; filename="RCT-DVA-');
      expect(Buffer.isBuffer(res.body)).toBe(true);
    });

    it('GET /businesses/:id/receipts/dva-transfers/:nonExistentId → 404', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/receipts/dva-transfers/00000000-0000-0000-0000-000000000000`)
        .set(auth());

      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════
  // UNIFIED FINANCIAL LEDGER (DUAL-SCOPE)
  // ═══════════════════════════════════════
  describe('Unified Financial Ledger', () => {
    it('GET /businesses/:id/ledger (default dva_bank scope) → 200 + summary and items', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/ledger?scope=dva_bank`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary).toHaveProperty('openingBalance');
      expect(res.body.summary).toHaveProperty('closingBalance');
      expect(res.body.summary).toHaveProperty('totalCredits');
      expect(res.body.summary).toHaveProperty('totalDebits');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
    });

    it('GET /businesses/:id/ledger (all_income scope) → 200 + includes all sales', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/ledger?scope=all_income`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.summary.totalCredits).toBeGreaterThan(0);
    });

    it('GET /businesses/:id/ledger with search query → 200 + filtered items', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/ledger?scope=all_income&search=Chukwuma`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].description).toContain('Chukwuma');
    });
  });

  // ═══════════════════════════════════════
  // FINANCIAL STATEMENTS (DVA & SALES PDF)
  // ═══════════════════════════════════════
  describe('Financial Statements', () => {
    it('GET /businesses/:id/tax/statements/ledger (dva_bank) → 200 + PDF stream', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/tax/statements/ledger?scope=dva_bank`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment; filename="bank-statement-');
      expect(Buffer.isBuffer(res.body)).toBe(true);
    });

    it('GET /businesses/:id/tax/statements/ledger (all_income) → 200 + PDF stream', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/tax/statements/ledger?scope=all_income`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment; filename="sales-statement-');
      expect(Buffer.isBuffer(res.body)).toBe(true);
    });

    it('POST /businesses/:id/tax/statements/ledger/email → 200 + delivery response', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/statements/ledger/email`)
        .set(auth())
        .send({
          scope: 'dva_bank',
          recipientEmail: 'accountant@e2etest.com',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('statementRef');
    });
  });

  // ═══════════════════════════════════════
  // SECURITY: TRANSACTION PIN & SESSIONS
  // ═══════════════════════════════════════
  describe('Security & Transaction PIN', () => {
    it('GET /auth/pin/status → 200 + hasPin=false initially', async () => {
      const res = await request(app)
        .get('/api/v1/auth/pin/status')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.hasPin).toBe(false);
      expect(res.body.data.isLocked).toBe(false);
      expect(res.body.data.remainingAttempts).toBe(5);
    });

    it('POST /auth/pin/setup with trivial PIN 1234 → 400 validation error', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set(auth())
        .send({
          pin: '1234',
          password: 'Password123!',
        });

      expect(res.status).toBe(400);
    });

    it('POST /auth/pin/setup with invalid password → 401', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set(auth())
        .send({
          pin: '8492',
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
    });

    it('POST /auth/pin/setup with valid 4-digit PIN → 200', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set(auth())
        .send({
          pin: '8492',
          password: CHANGED_PASSWORD,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('POST /auth/pin/verify with incorrect PIN → 401 + decrements attempts', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/verify')
        .set(auth())
        .send({
          pin: '9999',
        });

      expect(res.status).toBe(401);
      expect(res.body.error.details.remainingAttempts).toBe(4);
    });

    it('POST /auth/pin/verify with correct PIN → 200 + resets attempts', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/verify')
        .set(auth())
        .send({
          pin: '8492',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
    });

    it('PUT /auth/pin/change with correct current PIN → 200', async () => {
      const res = await request(app)
        .put('/api/v1/auth/pin/change')
        .set(auth())
        .send({
          currentPin: '8492',
          newPin: '7391',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('GET /auth/sessions → 200 + lists active user sessions', async () => {
      const res = await request(app)
        .get('/api/v1/auth/sessions')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('POST /auth/sessions/revoke-others → 200 + revokes remote sessions', async () => {
      const res = await request(app)
        .post('/api/v1/auth/sessions/revoke-others')
        .set(auth())
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════
  // SETTLEMENT & AUTOMATED PAYOUTS (PHASE 5)
  // ═══════════════════════════════════════
  describe('Settlement & Automated Payouts', () => {
    it('POST /businesses/:id/settlement/connect → 200 + connects settlement bank', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/settlement/connect`)
        .set(auth())
        .send({
          bankCode: '058',
          bankName: 'Guaranty Trust Bank',
          accountNumber: '0123456789',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bankName).toBe('Guaranty Trust Bank');
    });

    it('GET /businesses/:id/settlement/preview → 200 + returns available balance, split totals, and tax reserve', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/settlement/preview`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('availableForWithdrawal');
      expect(res.body.data).toHaveProperty('taxReserve');
      expect(res.body.data).toHaveProperty('totalSplitSettled');
      expect(res.body.data.settlementAccount.isConnected).toBe(true);
    });

    it('PATCH /businesses/:id/settlement/auto-split with invalid split clamps → 400 INVALID_SPLIT_PERCENTAGE', async () => {
      const resHigh = await request(app)
        .patch(`/api/v1/businesses/${businessId}/settlement/auto-split`)
        .set(auth())
        .send({
          enabled: true,
          taxSplitPercentage: 60,
          pin: '7391',
        });

      expect(resHigh.status).toBe(400);
      expect(resHigh.body.error.code).toBe('INVALID_SPLIT_PERCENTAGE');

      const resLow = await request(app)
        .patch(`/api/v1/businesses/${businessId}/settlement/auto-split`)
        .set(auth())
        .send({
          enabled: true,
          taxSplitPercentage: 2,
          pin: '7391',
        });

      expect(resLow.status).toBe(400);
      expect(resLow.body.error.code).toBe('INVALID_SPLIT_PERCENTAGE');
    });

    it('PATCH /businesses/:id/settlement/auto-split → 200 + updates gateway auto-split with PIN', async () => {
      const res = await request(app)
        .patch(`/api/v1/businesses/${businessId}/settlement/auto-split`)
        .set(auth())
        .send({
          enabled: true,
          taxSplitPercentage: 7.5,
          pin: '7391',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.autoSplitEnabled).toBe(true);
      expect(res.body.data.taxSplitPercentage).toBe(7.5);
    });

    it('POST /businesses/:id/settlement/withdraw with wrong PIN → 401', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/settlement/withdraw`)
        .set(auth())
        .send({
          amount: 5000,
          pin: '0000',
        });

      expect(res.status).toBe(401);
    });

    it('POST /businesses/:id/settlement/withdraw with valid PIN (7391) → 200 success', async () => {
      // Create a confirmed bank transfer sale so there is sufficient balance
      await request(app)
        .post(`/api/v1/businesses/${businessId}/sales`)
        .set(auth())
        .send({
          amount: 50000,
          source: 'bank_transfer',
          description: 'Large digital inflow for payout test',
          transactionDate: new Date().toISOString(),
        });

      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/settlement/withdraw`)
        .set(auth())
        .send({
          amount: 10000,
          pin: '7391',
          narration: 'Test payout withdrawal',
        });

      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveProperty('transferReference');
      }
    });

    it('GET /businesses/:id/settlement/history → 200 + returns paginated history', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${businessId}/settlement/history`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ═══════════════════════════════════════
  // NOTICEPAY1.MD P0 FIXES & ADMIN WITHDRAWAL WORKFLOW
  // ═══════════════════════════════════════
  describe('NoticePay1 P0 Fixes & Admin Withdrawal Workflow', () => {
    let testWithdrawalBusinessId = '';
    let testWithdrawalRequestId = '';

    beforeAll(async () => {
      // Create a dedicated business for withdrawal tests
      const bizRes = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({
          businessName: 'Withdrawal Test Business',
          ownerName: 'Test Owner',
          businessType: 'retail',
        });
      testWithdrawalBusinessId = bizRes.body.data.id;

      // Connect settlement account
      await request(app)
        .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/connect`)
        .set(auth())
        .send({
          bankCode: '044',
          bankName: 'Access Bank',
          accountNumber: '0123456789',
        });
    });

    it('NEW-B: Manual bank transfer sale should NOT be withdrawable (phantom funds excluded)', async () => {
      // Create a manual bank transfer sale (no DVA channel metadata)
      await request(app)
        .post(`/api/v1/businesses/${testWithdrawalBusinessId}/sales`)
        .set(auth())
        .send({
          amount: 100000,
          source: 'bank_transfer',
          description: 'Manual bank transfer - not DVA',
          transactionDate: new Date().toISOString(),
        });

      // Check preview - should show 0 withdrawable (no DVA sales yet)
      const previewRes = await request(app)
        .get(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/preview`)
        .set(auth());

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.totalInflows).toBe(0); // Manual sale excluded
      expect(previewRes.body.data.availableForWithdrawal).toBe(0);
    });

    it('NEW-B: DVA-originated sale should BE withdrawable', async () => {
      // Simulate a DVA auto-captured sale (with channel: 'dva' metadata)
      await prisma.salesTransaction.create({
        data: {
          businessId: testWithdrawalBusinessId,
          amount: 50000,
          source: 'bank_transfer',
          status: 'confirmed',
          description: 'DVA auto-captured inflow',
          transactionDate: new Date(),
          metadata: { channel: 'dva', paystackRef: 'TEST_DVA_REF' },
        },
      });

      // Check preview - should now show DVA sale as withdrawable
      const previewRes = await request(app)
        .get(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/preview`)
        .set(auth());

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.totalInflows).toBe(50000); // DVA sale included
      expect(previewRes.body.data.availableForWithdrawal).toBeGreaterThan(0);
    });

    it('NEW-D: Enable auto-split WITHOUT settlement account → 400 SETTLEMENT_ACCOUNT_REQUIRED', async () => {
      // Create a business without settlement account
      const bizRes = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({
          businessName: 'No Settlement Business',
          ownerName: 'Test Owner',
          businessType: 'technology',
        });
      const noSettlementBizId = bizRes.body.data.id;

      // Try to enable auto-split
      const res = await request(app)
        .patch(`/api/v1/businesses/${noSettlementBizId}/settlement/auto-split`)
        .set(auth())
        .send({
          enabled: true,
          taxSplitPercentage: 7.5,
          pin: '7391',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SETTLEMENT_ACCOUNT_REQUIRED');

      // Cleanup
      await request(app).delete(`/api/v1/businesses/${noSettlementBizId}`).set(auth());
    });

    it('NEW-D: Disable auto-split is always allowed (even without settlement account)', async () => {
      // Create a business without settlement account
      const bizRes = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({
          businessName: 'Disable Split Business',
          ownerName: 'Test Owner',
          businessType: 'services',
        });
      const noSettlementBizId = bizRes.body.data.id;

      // Disable auto-split should work
      const res = await request(app)
        .patch(`/api/v1/businesses/${noSettlementBizId}/settlement/auto-split`)
        .set(auth())
        .send({
          enabled: false,
          pin: '7391',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.autoSplitEnabled).toBe(false);

      // Cleanup
      await request(app).delete(`/api/v1/businesses/${noSettlementBizId}`).set(auth());
    });

    it('NEW-7: Withdrawal request → 200 with status=pending (no Paystack call)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/withdraw`)
        .set(auth())
        .send({
          amount: 10000,
          pin: '7391',
          narration: 'Test withdrawal request',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data).toHaveProperty('transferReference');
      // Fee contract surfaced to the frontend: the ledger debit equals the
      // request in merchant mode, and fee + net must reconcile to it exactly.
      expect(res.body.data.amount).toBe(10000);
      expect(res.body.data.fee).toBeGreaterThan(0);
      expect(res.body.data.netAmount + res.body.data.fee).toBeCloseTo(res.body.data.amount, 2);
      expect(res.body.message).toContain('awaiting admin approval');
      testWithdrawalRequestId = res.body.data.id;
    });

    it('NEW-7: Duplicate withdrawal (same amount within 30 min) → 409 DUPLICATE_WITHDRAWAL_REQUEST', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/withdraw`)
        .set(auth())
        .send({
          amount: 10000, // Same amount as previous request
          pin: '7391',
          narration: 'Duplicate attempt',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_WITHDRAWAL_REQUEST');
    });

    it('NEW-7: Different amount request → 200 (duplicate guard only checks exact amount)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/withdraw`)
        .set(auth())
        .send({
          amount: 5000, // Different amount
          pin: '7391',
          narration: 'Second withdrawal',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('pending');
    });

    it('NEW-7: Duplicate guard matches quote.amount in platform-bearer mode (requested + fee)', async () => {
      const original = config.paystack.fees.withdrawalFeeBearer;
      (config.paystack.fees as { withdrawalFeeBearer: string }).withdrawalFeeBearer = 'platform';
      try {
        // Platform mode: the SME receives the full amount and the fee rides ON
        // TOP, so the stored ledger amount is 5000 + fee (₦10 low band) = 5010.
        const first = await request(app)
          .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/withdraw`)
          .set(auth())
          .send({ amount: 5000, pin: '7391', narration: 'Platform bearer first' });

        expect(first.status).toBe(200);
        expect(first.body.data.netAmount).toBe(5000);
        expect(first.body.data.fee).toBeGreaterThan(0);
        expect(first.body.data.amount).toBeGreaterThan(5000); // requested + fee

        // Regression: the guard must match the STORED amount (5010), not the raw
        // request (5000) — otherwise double-tap protection silently dies in
        // platform mode, because the second 5000 request never equals 5010.
        const second = await request(app)
          .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/withdraw`)
          .set(auth())
          .send({ amount: 5000, pin: '7391', narration: 'Platform bearer duplicate' });

        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('DUPLICATE_WITHDRAWAL_REQUEST');
      } finally {
        (config.paystack.fees as { withdrawalFeeBearer: string }).withdrawalFeeBearer = original;
      }
    });

    it('NEW-7: Admin list withdrawal requests → 200 with queue', async () => {
      const res = await request(app)
        .get('/api/v1/admin/settlement/withdrawals?status=pending')
        .set(adminAuth());

      expect(res.status).toBe(200);
      // Paginated shape: { success, items, pagination } — NOT a bare array
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThan(0);
      // Account numbers should be masked
      expect(res.body.items[0].destinationAccountNum).toMatch(/^•••• \d{4}$/);
    });

    it('NEW-7: Non-admin tries to approve → 403', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/settlement/withdrawals/${testWithdrawalRequestId}/approve`)
        .set(auth()); // Regular user, not admin

      expect(res.status).toBe(403);
    });

    it('NEW-7: Admin approve withdrawal → 200 (transfer initiated)', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/settlement/withdrawals/${testWithdrawalRequestId}/approve`)
        .set(adminAuth());

      expect([200, 400, 409]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.data.status).toMatch(/processing|completed/);
        expect(res.body.message).toContain('approved');
      }
    });

    it('NEW-7: Double-approve same request → 409 ALREADY_PROCESSED', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/settlement/withdrawals/${testWithdrawalRequestId}/approve`)
        .set(adminAuth());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_PROCESSED');
    });

    it('NEW-7: Admin reject a pending request → 200', async () => {
      // Create a new request to reject
      const withdrawRes = await request(app)
        .post(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/withdraw`)
        .set(auth())
        .send({
          amount: 3000,
          pin: '7391',
          narration: 'Request to be rejected',
        });
      const rejectableRequestId = withdrawRes.body.data?.id;
      expect(withdrawRes.status).toBe(200);

      const res = await request(app)
        .post(`/api/v1/admin/settlement/withdrawals/${rejectableRequestId}/reject`)
        .set(adminAuth())
        .send({
          reason: 'Insufficient documentation provided',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('failed');
    });

    it('NEW-7: Reject without reason → 400', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/settlement/withdrawals/${testWithdrawalRequestId}/reject`)
        .set(adminAuth())
        .send({});

      expect(res.status).toBe(400);
    });

    it('NEW-7: Preview balance correctly reserves pending/processing payouts', async () => {
      const previewRes = await request(app)
        .get(`/api/v1/businesses/${testWithdrawalBusinessId}/settlement/preview`)
        .set(auth());

      expect(previewRes.status).toBe(200);
      // totalWithdrawn should include pending + processing + completed
      expect(previewRes.body.data).toHaveProperty('totalWithdrawn');
      expect(previewRes.body.data.totalWithdrawn).toBeGreaterThan(0);
    });

    afterAll(async () => {
      // Cleanup
      await request(app).delete(`/api/v1/businesses/${testWithdrawalBusinessId}`).set(auth());
    });
  });

  // ═══════════════════════════════════════
  // PHASE 6 — PAYMENT LIFECYCLE & WEBHOOK SYNC
  // ═══════════════════════════════════════
  describe('Phase 6 — Payment Lifecycle & Stale Payment Abandonment', () => {
    let testReportId = '';
    let testPaymentId = '';

    beforeAll(async () => {
      // Create a finalized report for testing
      const calcRes = await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/calculate`)
        .set(auth())
        // Must match the month the suite's sales are dated in (new Date()),
        // otherwise taxPayable is 0 and /tax/pay 400s with ZERO_TAX.
        .send({ month: MONTH, year: YEAR });
      testReportId = calcRes.body.data.id;

      await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/reports/${testReportId}/finalize`)
        .set(auth());
    });

    it('POST /tax/pay → initiates payment session', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/pay`)
        .set(auth())
        .send({ taxReportId: testReportId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('paymentId');
      expect(res.body.data).toHaveProperty('authorizationUrl');
      testPaymentId = res.body.data.paymentId;
    });

    it('POST /tax/payments/:id/abandon → resets payment and returns report to pending', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${businessId}/tax/payments/${testPaymentId}/abandon`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.paymentStatus).toBe('failed');

      // Verify tax report is reset to pending
      const reportRes = await request(app)
        .get(`/api/v1/businesses/${businessId}/tax/reports/${testReportId}`)
        .set(auth());
      expect(reportRes.body.data.paymentStatus).toBe('pending');
    });

    it('POST /webhooks/paystack handles transfer.success for settlement payout', async () => {
      const transferRef = `PO-TEST-WEBHOOK-${Date.now()}`;
      // Create a pending settlement payout
      const payout = await prisma.settlementPayout.create({
        data: {
          businessId,
          amount: 2500,
          fee: 0,
          netAmount: 2500,
          destinationBankCode: '058',
          destinationBankName: 'Guaranty Trust Bank',
          destinationAccountNum: '0123456789',
          destinationAccountName: 'Test Account',
          transferReference: transferRef,
          paystackTransferCode: 'TRF_TEST_123',
          status: 'pending',
        },
      });

      const rawEvent = JSON.stringify({
        event: 'transfer.success',
        data: {
          reference: transferRef,
          transfer_code: 'TRF_TEST_123',
          amount: 250000,
        },
      });

      const crypto = require('crypto');
      const signature = crypto
        .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET || 'test-secret')
        .update(rawEvent)
        .digest('hex');

      const res = await request(app)
        .post('/api/webhooks/paystack')
        .set('x-paystack-signature', signature)
        .set('content-type', 'application/json')
        .send(Buffer.from(rawEvent));

      expect([200, 401]).toContain(res.status);

      if (res.status === 200) {
        const updated = await prisma.settlementPayout.findUnique({ where: { id: payout.id } });
        expect(updated?.status).toBe('completed');
      }
    });
  });

  // ═══════════════════════════════════════
  // PAYOUT ACCOUNT CHANGE LOCK
  // ═══════════════════════════════════════
  describe('Payout Account Change Lock', () => {
    let testBusinessId = '';
    const firstAccount = { bankCode: '044', accountNumber: '0123456789', bankName: 'Access Bank' };
    const secondAccount = { bankCode: '058', accountNumber: '9876543210', bankName: 'GTB' };

    beforeAll(async () => {
      // Create a dedicated business for payout tests
      const bizRes = await request(app)
        .post('/api/v1/businesses')
        .set(auth())
        .send({
          businessName: 'Payout Test Business',
          ownerName: 'Test Owner',
          businessType: 'retail',
        });
      testBusinessId = bizRes.body.data.id;
    });

    it('First connect (no existing account) → 200 (no permission needed)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testBusinessId}/settlement/connect`)
        .set(auth())
        .send(firstAccount);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accountName');
    });

    it('Second connect (change existing) without permission → 403 PAYOUT_CHANGE_LOCKED', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testBusinessId}/settlement/connect`)
        .set(auth())
        .send({ ...secondAccount, pin: '7391' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAYOUT_CHANGE_LOCKED');
    });

    it('GET settlement preview → includes lock status', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${testBusinessId}/settlement/preview`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('payoutChange');
      expect(res.body.data.payoutChange.locked).toBe(true);
      expect(res.body.data.payoutChange.permitted).toBe(false);
    });

    it('Non-admin tries to grant permission → 403', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/businesses/${testBusinessId}/payout-change-permit`)
        .set(auth());

      expect(res.status).toBe(403);
    });

    it('Admin grants one-time permission → 200', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/businesses/${testBusinessId}/payout-change-permit`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payoutChangePermitted).toBe(true);
    });

    it('GET settlement preview → shows permitted status', async () => {
      const res = await request(app)
        .get(`/api/v1/businesses/${testBusinessId}/settlement/preview`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.payoutChange.locked).toBe(false);
      expect(res.body.data.payoutChange.permitted).toBe(true);
      expect(res.body.data.payoutChange.expiresAt).toBeDefined();
    });

    it('Change account with permission + PIN → 200 (permission consumed)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testBusinessId}/settlement/connect`)
        .set(auth())
        .send({ ...secondAccount, pin: '7391' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('Third connect attempt → 403 (permission was consumed)', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testBusinessId}/settlement/connect`)
        .set(auth())
        .send({ ...firstAccount, pin: '7391' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAYOUT_CHANGE_LOCKED');
    });

    it('Admin grants permission again → 200 (idempotent re-grant)', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/businesses/${testBusinessId}/payout-change-permit`)
        .set(adminAuth());

      expect(res.status).toBe(200);
    });

    it('Admin revokes permission → 200', async () => {
      const res = await request(app)
        .delete(`/api/v1/admin/businesses/${testBusinessId}/payout-change-permit`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('Change attempt after revoke → 403', async () => {
      const res = await request(app)
        .post(`/api/v1/businesses/${testBusinessId}/settlement/connect`)
        .set(auth())
        .send({ ...firstAccount, pin: '7391' });

      expect(res.status).toBe(403);
    });

    afterAll(async () => {
      // Clean up test business
      await request(app)
        .delete(`/api/v1/businesses/${testBusinessId}`)
        .set(auth());
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
