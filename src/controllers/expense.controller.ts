import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  createExpenseSchema,
  updateExpenseSchema,
  expenseQuerySchema,
  expenseSummaryQuerySchema,
  expenseDailyQuerySchema,
} from '@/validators/expense.validator';
import * as expenseService from '@/services/expense.service';

export const create = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = createExpenseSchema.parse(req.body);
  const expense = await expenseService.createExpense(
    req.user!.userId,
    req.params.businessId,
    input
  );

  res.status(201).json({
    success: true,
    data: expense,
    message: 'Expense recorded successfully',
  });
});

export const getAll = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = expenseQuerySchema.parse(req.query);
  const result = await expenseService.listExpenses(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const expense = await expenseService.getExpenseById(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: expense,
  });
});

export const update = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = updateExpenseSchema.parse(req.body);
  const expense = await expenseService.updateExpense(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    input
  );

  res.status(200).json({
    success: true,
    data: expense,
    message: 'Expense updated successfully',
  });
});

export const remove = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await expenseService.deleteExpense(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'Expense deleted successfully',
  });
});

export const summary = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { month, year } = expenseSummaryQuerySchema.parse(req.query);
  const result = await expenseService.getMonthlySummary(
    req.user!.userId,
    req.params.businessId,
    month,
    year
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});

export const daily = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { date } = expenseDailyQuerySchema.parse(req.query);
  const result = await expenseService.getDailySummary(
    req.user!.userId,
    req.params.businessId,
    date
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});
