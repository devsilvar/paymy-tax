import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { CreateExpenseInput, UpdateExpenseInput } from '@/validators/expense.validator';
import { verifyBusinessOwnership } from '@/lib/ownership';

// ─── Helpers ────────────────────────────────────────────────

async function assertMonthNotLocked(
  businessId: string,
  expenseDate: Date,
  db: TxClient | typeof prisma = prisma
) {
  // UTC — taxMonth is written in UTC by calculateTax; using local-tz
  // derivation here would miss the row on UTC+ hosts and silently allow
  // edits to a locked/finalized month.
  const monthStart = new Date(
    Date.UTC(expenseDate.getUTCFullYear(), expenseDate.getUTCMonth(), 1)
  );

  const report = await db.monthlyTaxReport.findUnique({
    where: {
      businessId_taxMonth: {
        businessId,
        taxMonth: monthStart,
      },
    },
    select: { isLocked: true, isFinalized: true },
  });

  if (report?.isLocked) {
    throw new AppError(
      423,
      'This month is locked — tax has been paid. No edits allowed.',
      'PERIOD_LOCKED'
    );
  }

  if (report?.isFinalized) {
    throw new AppError(
      423,
      'This month is finalized. Un-finalize it before editing expenses.',
      'PERIOD_FINALIZED'
    );
  }
}

// ─── CRUD ───────────────────────────────────────────────────

export async function createExpense(
  userId: string,
  businessId: string,
  input: CreateExpenseInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);
  await assertMonthNotLocked(businessId, input.expenseDate, db);

  const quantity = input.quantity ?? 1;
  const unitPrice = Math.round((input.amount / quantity) * 100) / 100;

  const expense = await db.expense.create({
    data: {
      businessId,
      category: input.category,
      description: input.description,
      amount: input.amount,
      quantity,
      unitPrice,
      expenseDate: input.expenseDate,
      receiptUrl: input.receiptUrl,
      isDeductible: input.isDeductible ?? true,
      createdBy: userId,
    },
  });

  logAudit({
    userId,
    businessId,
    action: 'expense.created',
    resourceType: 'expense',
    resourceId: expense.id,
    newData: {
      amount: input.amount,
      quantity,
      unitPrice,
      category: input.category,
      isDeductible: expense.isDeductible,
    },
  }, tx);

  logger.info('Expense created', { expenseId: expense.id, businessId, userId });

  return expense;
}

export async function listExpenses(
  userId: string,
  businessId: string,
  query: {
    page: number;
    limit: number;
    category?: string;
    startDate?: Date;
    endDate?: Date;
    month?: number;
    year?: number;
  }
) {
  await verifyBusinessOwnership(userId, businessId);

  const where: any = { businessId };

  if (query.category) where.category = query.category;

  if (query.startDate || query.endDate) {
    where.expenseDate = {};
    if (query.startDate) where.expenseDate.gte = query.startDate;
    if (query.endDate) where.expenseDate.lte = query.endDate;
  }

  // Month/year filter takes precedence over date range
  if (query.month && query.year) {
    const monthStart = new Date(query.year, query.month - 1, 1);
    const monthEnd = new Date(query.year, query.month, 0);
    where.expenseDate = { gte: monthStart, lte: monthEnd };
  }

  const offset = (query.page - 1) * query.limit;

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      skip: offset,
      take: query.limit,
      orderBy: { expenseDate: 'desc' },
    }),
    prisma.expense.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.limit);

  return {
    data: expenses,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: query.page < totalPages,
      hasPrev: query.page > 1,
    },
  };
}

export async function getExpenseById(userId: string, businessId: string, expenseId: string) {
  await verifyBusinessOwnership(userId, businessId);

  const expense = await prisma.expense.findUnique({ where: { id: expenseId } });

  if (!expense || expense.businessId !== businessId) {
    throw new AppError(404, 'Expense not found', 'EXPENSE_NOT_FOUND');
  }

  return expense;
}

export async function updateExpense(
  userId: string,
  businessId: string,
  expenseId: string,
  input: UpdateExpenseInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const existing = await db.expense.findUnique({ where: { id: expenseId } });

  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Expense not found', 'EXPENSE_NOT_FOUND');
  }

  await assertMonthNotLocked(businessId, existing.expenseDate, db);

  // If expense date is changing, also check the new month isn't locked
  if (input.expenseDate && input.expenseDate.getTime() !== existing.expenseDate.getTime()) {
    await assertMonthNotLocked(businessId, input.expenseDate, db);
  }

  const effectiveAmount = input.amount !== undefined ? input.amount : Number(existing.amount);
  const effectiveQuantity = input.quantity !== undefined ? input.quantity : Number(existing.quantity ?? 1);

  const data: Record<string, any> = {};
  if (input.category !== undefined) data.category = input.category;
  if (input.description !== undefined) data.description = input.description;
  if (input.amount !== undefined) data.amount = input.amount;
  if (input.quantity !== undefined) data.quantity = input.quantity;
  if (input.amount !== undefined || input.quantity !== undefined) {
    data.unitPrice = Math.round((effectiveAmount / effectiveQuantity) * 100) / 100;
  }
  if (input.expenseDate !== undefined) data.expenseDate = input.expenseDate;
  if (input.receiptUrl !== undefined) data.receiptUrl = input.receiptUrl;
  if (input.isDeductible !== undefined) data.isDeductible = input.isDeductible;

  const updated = await db.expense.update({
    where: { id: expenseId },
    data,
  });

  logAudit({
    userId,
    businessId,
    action: 'expense.updated',
    resourceType: 'expense',
    resourceId: expenseId,
    oldData: {
      amount: Number(existing.amount),
      quantity: Number(existing.quantity ?? 1),
      unitPrice: existing.unitPrice ? Number(existing.unitPrice) : null,
      category: existing.category,
      isDeductible: existing.isDeductible,
    },
    newData: {
      ...input,
      ...(data.unitPrice !== undefined ? { unitPrice: data.unitPrice } : {}),
    } as Record<string, any>,
  }, tx);

  logger.info('Expense updated', { expenseId, businessId, userId });

  return updated;
}

export async function deleteExpense(
  userId: string,
  businessId: string,
  expenseId: string,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  await verifyBusinessOwnership(userId, businessId, db);

  const existing = await db.expense.findUnique({ where: { id: expenseId } });

  if (!existing || existing.businessId !== businessId) {
    throw new AppError(404, 'Expense not found', 'EXPENSE_NOT_FOUND');
  }

  await assertMonthNotLocked(businessId, existing.expenseDate, db);

  await db.expense.delete({
    where: { id: expenseId },
  });

  logAudit({
    userId,
    businessId,
    action: 'expense.deleted',
    resourceType: 'expense',
    resourceId: expenseId,
    oldData: { amount: Number(existing.amount), category: existing.category, description: existing.description },
  }, tx);

  logger.info('Expense deleted', { expenseId, businessId, userId });

  return { message: 'Expense deleted successfully' };
}

// ─── Daily Summary ──────────────────────────────────────────

/**
 * Same-day totals grouped by category + the day's register rows, plus the
 * same expense-intelligence ratio alerts scoped to the day.
 *
 * UTC day window — identical convention to the sales daily endpoint and
 * getMonthlySummary, so daily and monthly numbers always reconcile.
 */
export async function getDailySummary(
  userId: string,
  businessId: string,
  date?: string
) {
  await verifyBusinessOwnership(userId, businessId);

  const day = date ?? new Date().toISOString().slice(0, 10);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime())) {
    throw new AppError(400, 'Invalid date — expected YYYY-MM-DD', 'INVALID_DATE');
  }
  const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (day > tomorrowStr) {
    throw new AppError(
      400,
      'Date cannot be more than a day in the future',
      'INVALID_DATE'
    );
  }

  const dateFilter = { gte: dayStart, lte: dayEnd };

  const [expenseAgg, byCategory, transactions, salesAgg] = await Promise.all([
    // Total expenses for the day
    prisma.expense.aggregate({
      where: { businessId, expenseDate: dateFilter },
      _sum: { amount: true },
    }),

    // Breakdown by category
    prisma.expense.groupBy({
      by: ['category'],
      where: { businessId, expenseDate: dateFilter },
      _sum: { amount: true },
      _count: true,
    }),

    // Register: the day's rows — capped to keep the payload bounded
    prisma.expense.findMany({
      where: { businessId, expenseDate: dateFilter },
      orderBy: { expenseDate: 'desc' },
      take: 200,
      select: {
        id: true,
        amount: true,
        quantity: true,
        unitPrice: true,
        category: true,
        description: true,
        expenseDate: true,
        isDeductible: true,
      },
    }),

    // Same-day settled sales — powers the low/high expense ratio alerts
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: dateFilter,
        status: { in: ['confirmed', 'completed'] },
      },
      _sum: { amount: true },
    }),
  ]);

  const totalExpenses = Number(expenseAgg._sum.amount ?? 0);
  const totalSales = Number(salesAgg._sum.amount ?? 0);

  // Same thresholds/rule as the monthly intelligence block below
  const alerts: { type: string; message: string }[] = [];
  if (totalSales > 0) {
    const ratio = totalExpenses / totalSales;
    const percentage = (ratio * 100).toFixed(1);
    if (ratio < LOW_EXPENSE_THRESHOLD) {
      alerts.push({
        type: 'LOW_EXPENSE_WARNING',
        message: `Your expenses (${percentage}% of sales) are unusually low today. You may be forgetting to log expenses — this inflates your taxable profit.`,
      });
    } else if (ratio > HIGH_EXPENSE_THRESHOLD) {
      alerts.push({
        type: 'HIGH_EXPENSE_WARNING',
        message: `Your expenses (${percentage}% of sales) are unusually high today. Double-check your entries for typos or duplicates.`,
      });
    }
  }

  return {
    date: day,
    totalExpenses,
    totalSales,
    transactionCount: transactions.length,
    categoryBreakdown: byCategory.map((entry) => ({
      category: entry.category,
      total: entry._sum.amount ?? 0,
      count: entry._count,
    })),
    alerts,
    transactions,
  };
}

// ─── Summary with Expense Intelligence ──────────────────────

const LOW_EXPENSE_THRESHOLD = 0.05;  // below 5% of sales → probably forgot to log
const HIGH_EXPENSE_THRESHOLD = 0.90; // above 90% of sales → suspiciously high

export async function getMonthlySummary(
  userId: string,
  businessId: string,
  month: number,
  year: number
) {
  await verifyBusinessOwnership(userId, businessId);

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);

  const dateFilter = { gte: monthStart, lte: monthEnd };

  const [expenseAgg, byCategory, expenseCount, salesAgg] = await Promise.all([
    // Total expenses for the month
    prisma.expense.aggregate({
      where: { businessId, expenseDate: dateFilter },
      _sum: { amount: true },
    }),

    // Breakdown by category
    prisma.expense.groupBy({
      by: ['category'],
      where: { businessId, expenseDate: dateFilter },
      _sum: { amount: true },
      _count: true,
    }),

    // Total count
    prisma.expense.count({
      where: { businessId, expenseDate: dateFilter },
    }),

    // Completed sales for the same month — needed for expense intelligence.
    // Same settled-status rule as the sales overview: 'confirmed' is canonical,
    // 'completed' is the legacy manual-entry status.
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: dateFilter,
        status: { in: ['confirmed', 'completed'] },
      },
      _sum: { amount: true },
    }),
  ]);

  const totalExpenses = Number(expenseAgg._sum.amount ?? 0);
  const totalSales = Number(salesAgg._sum.amount ?? 0);

  const categoryBreakdown = byCategory.map((entry) => ({
    category: entry.category,
    total: entry._sum.amount ?? 0,
    count: entry._count,
  }));

  // ── Expense Intelligence Alerts ──
  const alerts: { type: string; message: string }[] = [];

  if (totalSales > 0) {
    const ratio = totalExpenses / totalSales;
    const percentage = (ratio * 100).toFixed(1);

    // Pattern 1: Too few expenses — user probably forgot to log them.
    // They'll overpay on tax because gross profit is artificially high.
    if (ratio < LOW_EXPENSE_THRESHOLD) {
      alerts.push({
        type: 'LOW_EXPENSE_WARNING',
        message: `Your expenses (${percentage}% of sales) are unusually low. `
          + `Make sure you've recorded all business expenses — missing expenses will increase your tax liability.`,
      });
    }

    // Pattern 2: Too many expenses — expenses eating almost all revenue.
    // Could be legitimate (bad month), but could also be inflated to reduce tax.
    // Flag it so admin/FIRS can review if needed.
    if (ratio > HIGH_EXPENSE_THRESHOLD) {
      alerts.push({
        type: 'HIGH_EXPENSE_WARNING',
        message: `Your expenses (${percentage}% of sales) are unusually high. `
          + `This significantly reduces your taxable profit. Please ensure all expense entries are accurate and supported by receipts.`,
      });
    }
  }

  // Pattern 3: Expenses logged but zero sales — might be a new month where
  // sales haven't been entered yet.
  if (totalSales === 0 && totalExpenses > 0) {
    alerts.push({
      type: 'NO_SALES_WARNING',
      message: `You have expenses recorded but no sales for this month. `
        + `Make sure you've entered all sales before finalizing.`,
    });
  }

  return {
    month,
    year,
    totalExpenses,
    totalSales,
    transactionCount: expenseCount,
    categoryBreakdown,
    alerts,
  };
}
