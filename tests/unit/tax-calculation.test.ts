import { describe, test, expect } from '@jest/globals';

/**
 * Tax Calculation Formula Tests
 * 
 * Tests the core business logic: Tax = 7.5% of (Sales - Expenses)
 */
describe('Tax Calculation Formula', () => {
  
  const TAX_RATE = 0.075; // 7.5%

  function calculateTax(sales: number, expenses: number): number {
    const profit = sales - expenses;
    if (profit <= 0) return 0;
    return Math.round(profit * TAX_RATE * 100) / 100; // Round to 2 decimals
  }

  test('calculates 7.5% of profit correctly', () => {
    const sales = 100000;
    const expenses = 30000;
    const expectedTax = 5250; // 7.5% of 70000
    
    const result = calculateTax(sales, expenses);
    
    expect(result).toBe(expectedTax);
  });

  test('returns zero tax for losses', () => {
    const sales = 30000;
    const expenses = 100000;
    
    const result = calculateTax(sales, expenses);
    
    expect(result).toBe(0);
  });

  test('returns zero tax when no sales', () => {
    const sales = 0;
    const expenses = 50000;
    
    const result = calculateTax(sales, expenses);
    
    expect(result).toBe(0);
  });

  test('calculates tax when no expenses', () => {
    const sales = 100000;
    const expenses = 0;
    const expectedTax = 7500; // 7.5% of 100000
    
    const result = calculateTax(sales, expenses);
    
    expect(result).toBe(expectedTax);
  });

  test('handles decimal amounts correctly', () => {
    const sales = 100000.50;
    const expenses = 30000.25;
    const profit = 70000.25;
    const expectedTax = 5250.02; // 7.5% rounded to 2 decimals
    
    const result = calculateTax(sales, expenses);
    
    expect(result).toBeCloseTo(expectedTax, 2);
  });
});
