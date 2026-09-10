import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import { WalletService } from '../../src/services/wallet.service';
import type { Application } from 'express';

describe('Central User Wallet API Integration', () => {
  let app: Application;
  let userA: any;
  let userB: any;
  let tokenA: string;
  let tokenB: string;
  let businessA: any;

  beforeAll(async () => {
    app = createApp();
    await clearDatabase();

    userA = await createTestUser('wallet-user-a@example.com');
    userB = await createTestUser('wallet-user-b@example.com');

    businessA = await createTestBusiness(userA.id, 'Alpha Store');

    tokenA = jwt.sign(
      { userId: userA.id, email: userA.email, role: 'user' },
      config.jwt.accessSecret,
      { expiresIn: '1h' }
    );

    tokenB = jwt.sign(
      { userId: userB.id, email: userB.email, role: 'user' },
      config.jwt.accessSecret,
      { expiresIn: '1h' }
    );
  }, 30000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 30000);

  test('GET /api/v1/wallet without authorization token returns 401', async () => {
    const res = await request(app).get('/api/v1/wallet');
    expect(res.status).toBe(401);
  });

  test('GET /api/v1/wallet initializes and returns zero balance for new user', async () => {
    const res = await request(app)
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      userId: userA.id,
      balance: 0,
      lockedBalance: 0,
      availableBalance: 0,
      currency: 'NGN',
      version: 0,
    });
  });

  test('GET /api/v1/wallet reflects credited funds and fund reservation', async () => {
    // Credit ₦50,000 into User A's wallet
    await WalletService.creditWallet({
      userId: userA.id,
      businessId: businessA.id,
      amount: 50000,
      fee: 250,
      netAmount: 49750,
      reference: 'WAL-API-TEST-001',
      source: 'dva',
      description: 'DVA transfer from customer',
    });

    const res1 = await request(app)
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res1.status).toBe(200);
    expect(res1.body.data.balance).toBe(49750);
    expect(res1.body.data.lockedBalance).toBe(0);
    expect(res1.body.data.availableBalance).toBe(49750);

    // Reserve ₦10,000 for payout
    await WalletService.reserveFunds({
      userId: userA.id,
      amount: 10000,
      reference: 'RES-API-TEST-001',
    });

    const res2 = await request(app)
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res2.status).toBe(200);
    expect(res2.body.data.balance).toBe(49750);
    expect(res2.body.data.lockedBalance).toBe(10000);
    expect(res2.body.data.availableBalance).toBe(39750);
  });

  test('GET /api/v1/wallet/history returns paginated transactions', async () => {
    const res = await request(app)
      .get('/api/v1/wallet/history?page=1&limit=10')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      reference: 'WAL-API-TEST-001',
      amount: 50000,
      fee: 250,
      netAmount: 49750,
      source: 'dva',
      type: 'credit',
    });
    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
  });

  test('Strict User Isolation: User B cannot see User A wallet balance or history', async () => {
    // User B balance should be 0
    const resBalance = await request(app)
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(resBalance.status).toBe(200);
    expect(resBalance.body.data.userId).toBe(userB.id);
    expect(resBalance.body.data.balance).toBe(0);

    // User B history should be empty
    const resHistory = await request(app)
      .get('/api/v1/wallet/history')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(resHistory.status).toBe(200);
    expect(resHistory.body.data).toHaveLength(0);
    expect(resHistory.body.pagination.total).toBe(0);
  });

  test('GET /api/v1/wallet/history filters by type correctly', async () => {
    const resCredits = await request(app)
      .get('/api/v1/wallet/history?type=credit')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(resCredits.status).toBe(200);
    expect(resCredits.body.data).toHaveLength(1);

    const resDebits = await request(app)
      .get('/api/v1/wallet/history?type=debit')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(resDebits.status).toBe(200);
    expect(resDebits.body.data).toHaveLength(0);
  });
});
