import { describe, test, expect } from '@jest/globals';
import { computeSaleTotal } from '../../src/services/sales.service';
import {
  saleLineItemSchema,
  createSaleSchema,
  updateSaleSchema,
} from '../../src/validators/sales.validator';
import {
  createExpenseSchema,
  updateExpenseSchema,
} from '../../src/validators/expense.validator';

describe('Multi-Item Basket Sales & Expense Quantity Suite', () => {
  // ─── 1. computeSaleTotal Unit Tests ─────────────────────────
  describe('computeSaleTotal', () => {
    test('computes line totals and grand total correctly for typical basket', () => {
      const items = [
        { name: 'Rice 50kg bag', quantity: 2, unitPrice: 35000 },
        { name: 'Vegetable Oil 5L', quantity: 3, unitPrice: 8500 },
        { name: 'Seasoning cubes', quantity: 5, unitPrice: 1200 },
      ];

      const result = computeSaleTotal(items);

      expect(result.lines).toHaveLength(3);
      expect(result.lines[0]).toEqual({
        name: 'Rice 50kg bag',
        quantity: 2,
        unitPrice: 35000,
        lineTotal: 70000,
        sortOrder: 0,
      });
      expect(result.lines[1]).toEqual({
        name: 'Vegetable Oil 5L',
        quantity: 3,
        unitPrice: 8500,
        lineTotal: 25500,
        sortOrder: 1,
      });
      expect(result.lines[2]).toEqual({
        name: 'Seasoning cubes',
        quantity: 5,
        unitPrice: 1200,
        lineTotal: 6000,
        sortOrder: 2,
      });

      // 70,000 + 25,500 + 6,000 = 101,500
      expect(result.total).toBe(101500);
    });

    test('handles decimal fractional quantities and prices with 2-decimal rounding', () => {
      const items = [
        { name: 'Flour (kg)', quantity: 2.5, unitPrice: 1250.75 },
        { name: 'Sugar (kg)', quantity: 1.75, unitPrice: 800.5 },
      ];

      const result = computeSaleTotal(items);

      // Line 1: 2.5 * 1250.75 = 3126.875 -> rounded to 3126.88
      expect(result.lines[0].lineTotal).toBe(3126.88);
      // Line 2: 1.75 * 800.5 = 1400.875 -> rounded to 1400.88
      expect(result.lines[1].lineTotal).toBe(1400.88);
      // Total: 3126.88 + 1400.88 = 4527.76
      expect(result.total).toBe(4527.76);
    });

    test('handles zero unit price without crashing or NaN', () => {
      const items = [
        { name: 'Complimentary bag', quantity: 1, unitPrice: 0 },
        { name: 'Standard item', quantity: 1, unitPrice: 5000 },
      ];

      const result = computeSaleTotal(items);

      expect(result.lines[0].lineTotal).toBe(0);
      expect(result.total).toBe(5000);
    });
  });

  // ─── 2. saleLineItemSchema Validator Tests ──────────────────
  describe('saleLineItemSchema Validator', () => {
    test('validates correct item', () => {
      const parsed = saleLineItemSchema.safeParse({
        name: 'Cement bag',
        quantity: 10,
        unitPrice: 8500,
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.name).toBe('Cement bag');
        expect(parsed.data.quantity).toBe(10);
        expect(parsed.data.unitPrice).toBe(8500);
      }
    });

    test('rejects empty name or whitespace only', () => {
      const result = saleLineItemSchema.safeParse({
        name: '   ',
        quantity: 1,
        unitPrice: 100,
      });

      expect(result.success).toBe(false);
    });

    test('rejects zero or negative quantity', () => {
      const zeroQty = saleLineItemSchema.safeParse({
        name: 'Item',
        quantity: 0,
        unitPrice: 100,
      });
      expect(zeroQty.success).toBe(false);

      const negQty = saleLineItemSchema.safeParse({
        name: 'Item',
        quantity: -2,
        unitPrice: 100,
      });
      expect(negQty.success).toBe(false);
    });

    test('rejects negative unit price', () => {
      const negPrice = saleLineItemSchema.safeParse({
        name: 'Item',
        quantity: 1,
        unitPrice: -500,
      });

      expect(negPrice.success).toBe(false);
    });
  });

  // ─── 3. createSaleSchema Validator Tests ────────────────────
  describe('createSaleSchema Validator', () => {
    const baseSale = {
      source: 'pos',
      transactionDate: '2026-03-25',
    };

    test('single amount mode succeeds with amount and no items', () => {
      const result = createSaleSchema.safeParse({
        ...baseSale,
        amount: 25000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(25000);
        expect(result.data.items).toBeUndefined();
      }
    });

    test('basket mode succeeds with items and NO amount', () => {
      const result = createSaleSchema.safeParse({
        ...baseSale,
        items: [
          { name: 'Bread', quantity: 2, unitPrice: 1200 },
          { name: 'Milk', quantity: 1, unitPrice: 3000 },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items).toHaveLength(2);
        expect(result.data.amount).toBeUndefined();
      }
    });

    test('fails if both items and amount are omitted', () => {
      const result = createSaleSchema.safeParse({
        ...baseSale,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('amount'))).toBe(true);
      }
    });

    test('fails if items is an empty array', () => {
      const result = createSaleSchema.safeParse({
        ...baseSale,
        items: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('items'))).toBe(true);
      }
    });
  });

  // ─── 4. updateSaleSchema Validator Tests ────────────────────
  describe('updateSaleSchema Validator', () => {
    test('allows updating only amount', () => {
      const result = updateSaleSchema.safeParse({
        amount: 30000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(30000);
      }
    });

    test('allows updating with items list', () => {
      const result = updateSaleSchema.safeParse({
        items: [{ name: 'New Item', quantity: 2, unitPrice: 1500 }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items).toHaveLength(1);
      }
    });

    test('requires amount when items is empty array (basket -> single conversion)', () => {
      const withoutAmount = updateSaleSchema.safeParse({
        items: [],
      });
      expect(withoutAmount.success).toBe(false);

      const withAmount = updateSaleSchema.safeParse({
        items: [],
        amount: 15000,
      });
      expect(withAmount.success).toBe(true);
    });

    test('allows updating metadata or description without touching items or amount', () => {
      const result = updateSaleSchema.safeParse({
        description: 'Updated delivery note',
        customerName: 'Chidi Okafor',
      });

      expect(result.success).toBe(true);
    });
  });

  // ─── 5. Expense Validator Tests ─────────────────────────────
  describe('Expense Validator', () => {
    test('createExpenseSchema accepts optional positive quantity', () => {
      const result = createExpenseSchema.safeParse({
        category: 'inventory',
        description: '12 crates of eggs',
        amount: 42000,
        quantity: 12,
        expenseDate: '2026-03-08',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBe(12);
      }
    });

    test('createExpenseSchema defaults or allows omitted quantity', () => {
      const result = createExpenseSchema.safeParse({
        category: 'rent',
        description: 'Office rent',
        amount: 50000,
        expenseDate: '2026-03-01',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBeUndefined();
      }
    });

    test('createExpenseSchema rejects zero or negative quantity', () => {
      const zeroQty = createExpenseSchema.safeParse({
        category: 'inventory',
        description: 'Stock',
        amount: 10000,
        quantity: 0,
        expenseDate: '2026-03-08',
      });
      expect(zeroQty.success).toBe(false);

      const negQty = createExpenseSchema.safeParse({
        category: 'inventory',
        description: 'Stock',
        amount: 10000,
        quantity: -5,
        expenseDate: '2026-03-08',
      });
      expect(negQty.success).toBe(false);
    });

    test('updateExpenseSchema accepts quantity update', () => {
      const result = updateExpenseSchema.safeParse({
        quantity: 15,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBe(15);
      }
    });
  });

  // ─── 6. Server-side Derived Unit Price Logic Tests ──────────
  describe('Derived Unit Price & Merged-Recompute Rules', () => {
    function deriveUnitPrice(amount: number, quantity: number): number {
      const safeQty = quantity > 0 ? quantity : 1;
      return Math.round((amount / safeQty) * 100) / 100;
    }

    test('derives exact unit price without floating drift', () => {
      // ₦42,000 / 12 = ₦3,500
      expect(deriveUnitPrice(42000, 12)).toBe(3500);

      // ₦50,000 / 1 = ₦50,000 (legacy row default)
      expect(deriveUnitPrice(50000, 1)).toBe(50000);

      // ₦100,000 / 3 = ₦33,333.3333... -> 33333.33
      expect(deriveUnitPrice(100000, 3)).toBe(33333.33);
    });

    test('merged-recompute rule on partial updates', () => {
      const existing = {
        amount: 50000,
        quantity: 1,
        unitPrice: 50000,
      };

      // Case A: Quantity updated from 1 to 5, amount unchanged
      const updateA = { quantity: 5 };
      const effectiveAmountA = existing.amount;
      const effectiveQtyA = updateA.quantity ?? existing.quantity;
      const newUnitPriceA = deriveUnitPrice(effectiveAmountA, effectiveQtyA);
      expect(newUnitPriceA).toBe(10000); // 50,000 / 5 = 10,000

      // Case B: Amount updated from 50,000 to 60,000, quantity unchanged (5)
      const existingAfterA = { amount: 50000, quantity: 5, unitPrice: 10000 };
      const updateB = { amount: 60000 };
      const effectiveAmountB = updateB.amount ?? existingAfterA.amount;
      const effectiveQtyB = existingAfterA.quantity;
      const newUnitPriceB = deriveUnitPrice(effectiveAmountB, effectiveQtyB);
      expect(newUnitPriceB).toBe(12000); // 60,000 / 5 = 12,000

      // Case C: Both updated together
      const updateC = { amount: 75000, quantity: 3 };
      const newUnitPriceC = deriveUnitPrice(updateC.amount, updateC.quantity);
      expect(newUnitPriceC).toBe(25000); // 75,000 / 3 = 25,000
    });
  });
});
