import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { aiChatSchema } from '@/validators/ai.validator';
import * as aiService from '@/services/ai/ai.service';

export const chat = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.params.businessId || req.params.id;
  const { message, history } = aiChatSchema.parse(req.body);

  const result = await aiService.generateAIResponse(
    businessId,
    req.user!.userId,
    message,
    history
  );

  res.status(200).json({
    success: true,
    reply: result.reply,
    data: result,
  });
});
