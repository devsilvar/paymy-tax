import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import * as salesService from '../../src/services/sales.service';
import * as expenseService from '../../src/services/expense.service';
import * as businessService from '../../src/services/business.service';

/**
 * Authorization Tests
 * 
 * Verifies that users cannot access other users' business data
 */
describe('Authorization - Cross-User Access Control', () => {
  let user1Id: string;
  let user2Id: string;
  let business1Id: string;
  let business2Id: string;

  beforeAll(async () => {
    await clearDatabase();
    
    const user1 = await createTestUser('user1@test.com');
    const user2 = await createTestUser('user2@test.com');
    
    user1Id = user1.id;
    user2Id = user2.id;
    
    const business1 = await createTestBusiness(user1Id, 'User 1 Business');
    const business2 = await createTestBusiness(user2Id, 'User 2 Business');
    
    business1Id = business1.id;
    business2Id = business2.id;
  }, 30000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 30000);

  test('user cannot access another user\'s business', async () => {
    await expect(
      businessService.getBusinessById(user1Id, business2Id)
    ).rejects.toThrow();
  });

  test('user cannot create sales for another user\'s business', async () => {
    await expect(
      salesService.createSale(user1Id, business2Id, {
        amount: 10000,
        source: 'manual',
        status: 'confirmed',
        transactionDate: new Date(),
      })
    ).rejects.toThrow();
  });

  test('user cannot list another user\'s sales', async () => {
    // Create sale for user2's business
    await salesService.createSale(user2Id, business2Id, {
      amount: 5000,
      source: 'manual',
      status: 'confirmed',
      transactionDate: new Date(),
    });

    // User1 tries to list user2's sales
    await expect(
      salesService.listSales(user1Id, business2Id, { page: 1, limit: 10 })
    ).rejects.toThrow();
  });

  test('user cannot create expenses for another user\'s business', async () => {
    await expect(
      expenseService.createExpense(user1Id, business2Id, {
        amount: 3000,
        category: 'rent',
        description: 'Test expense',
        expenseDate: new Date(),
      })
    ).rejects.toThrow();
  });

  test('user cannot delete another user\'s expenses', async () => {
    // Create expense for user2
    const expense = await expenseService.createExpense(user2Id, business2Id, {
      amount: 2000,
      category: 'marketing',
      description: 'Test',
      expenseDate: new Date(),
    });

    // User1 tries to delete it
    await expect(
      expenseService.deleteExpense(user1Id, business2Id, expense.id)
    ).rejects.toThrow();
  }, 10000);

  test('user can only see their own businesses', async () => {
    const result = await businessService.listBusinesses(user1Id, 1, 10);
    
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(business1Id);
  });
});
