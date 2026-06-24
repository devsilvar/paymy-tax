import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { testDb, clearDatabase, createTestUser, createTestBusiness } from '../helpers/test-db';
import * as salesService from '../../src/services/sales.service';
import * as expenseService from '../../src/services/expense.service';
import * as taxService from '../../src/services/tax.service';

/**
 * Soft Delete Integration Tests
 * 
 * Verifies that deleted records are hidden from queries but preserved in database
 */
describe('Soft Delete - Sales & Expenses', () => {
  let userId: string;
  let businessId: string;

  beforeAll(async () => {
    await clearDatabase();
    
    const user = await createTestUser('softdelete@test.com');
    const business = await createTestBusiness(user.id, 'Soft Delete Test Business');
    
    userId = user.id;
    businessId = business.id;
  }, 30000);

  afterAll(async () => {
    await clearDatabase();
    await testDb.$disconnect();
  }, 30000);

  test('deleted sales not in list', async () => {
    // Create sale
    const sale = await salesService.createSale(userId, businessId, {
      amount: 10000,
      source: 'manual',
      status: 'confirmed',
      transactionDate: new Date(),
    });

    // Verify it appears in list
    const beforeDelete = await salesService.listSales(userId, businessId, { page: 1, limit: 10 });
    expect(beforeDelete.data).toHaveLength(1);

    // Delete sale
    await salesService.deleteSale(userId, businessId, sale.id);

    // Verify it's gone from list
    const afterDelete = await salesService.listSales(userId, businessId, { page: 1, limit: 10 });
    expect(afterDelete.data).toHaveLength(0);
  }, 10000);

  test('deleted sales still in database with deletedAt set', async () => {
    // Create and delete sale
    const sale = await salesService.createSale(userId, businessId, {
      amount: 5000,
      source: 'manual',
      status: 'confirmed',
      transactionDate: new Date(),
    });

    await salesService.deleteSale(userId, businessId, sale.id);

    // Query database directly (bypasses service layer filters)
    const dbRecord = await testDb.salesTransaction.findUnique({
      where: { id: sale.id },
    });

    expect(dbRecord).not.toBeNull();
    expect(dbRecord!.deletedAt).not.toBeNull();
    expect(dbRecord!.deletedBy).toBe(userId);
  }, 10000);

  test('tax calculation excludes deleted sales', async () => {
    // Create sale for 100k
    const sale = await salesService.createSale(userId, businessId, {
      amount: 100000,
      source: 'manual',
      status: 'confirmed',
      transactionDate: new Date('2026-06-15'),
    });

    // Calculate tax
    const report1 = await taxService.calculateTax(userId, businessId, 6, 2026);
    expect(report1.totalSales).toBe(100000);
    expect(report1.taxPayable).toBe(7500); // 7.5% of 100k

    // Delete sale
    await salesService.deleteSale(userId, businessId, sale.id);

    // Recalculate - should be zero
    const report2 = await taxService.calculateTax(userId, businessId, 6, 2026);
    expect(report2.totalSales).toBe(0);
    expect(report2.taxPayable).toBe(0);
  }, 10000);

  test('deleted expenses not in list', async () => {
    // Create expense
    const expense = await expenseService.createExpense(userId, businessId, {
      amount: 3000,
      category: 'rent',
      description: 'Test expense',
      expenseDate: new Date(),
    });

    // Verify it appears
    const beforeDelete = await expenseService.listExpenses(userId, businessId, { page: 1, limit: 10 });
    expect(beforeDelete.data.length).toBeGreaterThan(0);

    // Delete
    await expenseService.deleteExpense(userId, businessId, expense.id);

    // Query again - should have one less
    const afterDelete = await expenseService.listExpenses(userId, businessId, { page: 1, limit: 10 });
    expect(afterDelete.data.length).toBe(beforeDelete.data.length - 1);
  }, 10000);

  test('tax calculation excludes deleted expenses', async () => {
    // Create sale and expense
    const sale = await salesService.createSale(userId, businessId, {
      amount: 100000,
      source: 'manual',
      status: 'confirmed',
      transactionDate: new Date('2026-07-15'),
    });

    const expense = await expenseService.createExpense(userId, businessId, {
      amount: 30000,
      category: 'inventory',
      description: 'Stock',
      expenseDate: new Date('2026-07-15'),
    });

    // Calculate tax - should be 7.5% of 70k = 5250
    const report1 = await taxService.calculateTax(userId, businessId, 7, 2026);
    expect(report1.totalSales).toBe(100000);
    expect(report1.totalExpenses).toBe(30000);
    expect(report1.taxPayable).toBe(5250);

    // Delete expense
    await expenseService.deleteExpense(userId, businessId, expense.id);

    // Recalculate - expense should be zero, tax higher
    const report2 = await taxService.calculateTax(userId, businessId, 7, 2026);
    expect(report2.totalExpenses).toBe(0);
    expect(report2.taxPayable).toBe(7500); // 7.5% of 100k
  }, 10000);

  test('deleted sale not accessible via getSaleById', async () => {
    const sale = await salesService.createSale(userId, businessId, {
      amount: 1000,
      source: 'manual',
      status: 'confirmed',
      transactionDate: new Date(),
    });

    // Should be accessible before delete
    const fetched = await salesService.getSaleById(userId, businessId, sale.id);
    expect(fetched.id).toBe(sale.id);

    // Delete
    await salesService.deleteSale(userId, businessId, sale.id);

    // Should throw 404 after delete
    await expect(
      salesService.getSaleById(userId, businessId, sale.id)
    ).rejects.toThrow('Sale not found');
  }, 10000);

  test('deleted expense not accessible via getExpenseById', async () => {
    const expense = await expenseService.createExpense(userId, businessId, {
      amount: 500,
      category: 'utilities',
      description: 'Electric',
      expenseDate: new Date(),
    });

    // Accessible before delete
    const fetched = await expenseService.getExpenseById(userId, businessId, expense.id);
    expect(fetched.id).toBe(expense.id);

    // Delete
    await expenseService.deleteExpense(userId, businessId, expense.id);

    // Should throw 404
    await expect(
      expenseService.getExpenseById(userId, businessId, expense.id)
    ).rejects.toThrow('Expense not found');
  }, 10000);
});
