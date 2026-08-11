import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { CreateExpenseInput, UpdateExpenseInput } from '@/validators/expense.validator';

// ─── Helpers ────────────────────────────────────────────────

async function verifyBusinessOwnership(
  userId: string,
  businessId: string,
  db: TxClient | typeof prisma = prisma
) {
  const business = await db.business.findUnique({ where: { id: businessId } });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  return business;
}

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

  const expense = await db.expense.create({
    data: {
      businessId,
      category: input.category,
      description: input.description,
      amount: input.amount,
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
    newData: { amount: input.amount, category: input.category, isDeductible: expense.isDeductible },
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

  const data: Record<string, any> = {};
  if (input.category !== undefined) data.category = input.category;
  if (input.description !== undefined) data.description = input.description;
  if (input.amount !== undefined) data.amount = input.amount;
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
    oldData: { amount: Number(existing.amount), category: existing.category, isDeductible: existing.isDeductible },
    newData: input as Record<string, any>,
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

    // Confirmed sales for the same month — needed for expense intelligence
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: dateFilter,
        status: 'confirmed',
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
