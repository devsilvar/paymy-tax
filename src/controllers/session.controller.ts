import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as sessionService from '@/services/session.service';

export const listSessions = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const currentRefreshToken = (req.headers['x-refresh-token'] as string) || (req.body?.refreshToken as string);
  const sessions = await sessionService.listUserSessions(
    req.user!.userId,
    currentRefreshToken
  );
  res.json({ success: true, data: sessions });
});

export const revokeSession = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await sessionService.revokeSession(
    req.user!.userId,
    req.params.sessionId,
    req.ip,
    req.get('user-agent')
  );
  res.json({ success: true, message: result.message });
});

export const revokeAllOtherSessions = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const currentRefreshToken = (req.headers['x-refresh-token'] as string) || (req.body?.refreshToken as string) || '';
  const result = await sessionService.revokeAllOtherSessions(
    req.user!.userId,
    currentRefreshToken,
    req.ip,
    req.get('user-agent')
  );
  res.json({ success: true, count: result.count, message: result.message });
});
