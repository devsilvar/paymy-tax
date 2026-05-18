import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  generateRemindersSchema,
  reminderQuerySchema,
} from '@/validators/reminder.validator';
import * as reminderService from '@/services/reminder.service';

export const generate = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { month, year } = generateRemindersSchema.parse(req.body);
  const result = await reminderService.generateReminders(
    req.user!.userId,
    req.params.businessId,
    month,
    year
  );

  res.status(result.created ? 201 : 200).json({
    success: true,
    data: result,
  });
});

export const getAll = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = reminderQuerySchema.parse(req.query);
  const result = await reminderService.listReminders(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getActive = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const reminders = await reminderService.getActiveReminders(
    req.user!.userId,
    req.params.businessId
  );

  res.status(200).json({
    success: true,
    data: reminders,
  });
});

export const markSent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const reminder = await reminderService.markReminderSent(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: reminder,
    message: 'Reminder marked as sent',
  });
});

export const dismiss = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await reminderService.dismissReminder(
    req.user!.userId,
    req.params.businessId,
    req.params.id
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'Reminder dismissed successfully',
  });
});
