import crypto from 'crypto';
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';

export interface UserSessionDto {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceInfo?: string | null;
  lastActiveAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseDeviceName(userAgent?: string | null): string {
  if (!userAgent) return 'Unknown Device';

  let browser = 'Browser';
  if (userAgent.includes('Chrome')) browser = 'Chrome';
  else if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Safari')) browser = 'Safari';
  else if (userAgent.includes('Edge')) browser = 'Edge';

  let os = 'Unknown OS';
  if (userAgent.includes('Windows')) os = 'Windows';
  else if (userAgent.includes('Mac OS')) os = 'macOS';
  else if (userAgent.includes('Android')) os = 'Android';
  else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';
  else if (userAgent.includes('Linux')) os = 'Linux';

  return `${browser} on ${os}`;
}

export async function recordSession(
  userId: string,
  refreshToken: string,
  ipAddress?: string,
  userAgent?: string
): Promise<string> {
  const tokenHash = hashRefreshToken(refreshToken);
  const deviceInfo = parseDeviceName(userAgent);

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: tokenHash,
      ipAddress,
      userAgent,
      deviceInfo,
      lastActiveAt: new Date(),
    },
  });

  return session.id;
}

export async function listUserSessions(
  userId: string,
  currentRefreshToken?: string
): Promise<UserSessionDto[]> {
  const currentHash = currentRefreshToken ? hashRefreshToken(currentRefreshToken) : null;

  const sessions = await prisma.session.findMany({
    where: {
      userId,
      isRevoked: false,
    },
    orderBy: { lastActiveAt: 'desc' },
  });

  return sessions.map((s) => ({
    id: s.id,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    deviceInfo: s.deviceInfo || parseDeviceName(s.userAgent),
    lastActiveAt: s.lastActiveAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    isCurrent: Boolean(currentHash && s.refreshTokenHash === currentHash),
  }));
}

export async function revokeSession(
  userId: string,
  sessionId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; message: string }> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });

  if (!session) {
    throw new AppError(404, 'Session not found', 'SESSION_NOT_FOUND');
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: { isRevoked: true },
  });

  logAudit({
    userId,
    action: 'session.revoked',
    resourceType: 'user_session',
    resourceId: sessionId,
    ipAddress,
    userAgent,
    newData: { sessionId },
  });

  logger.info('User session revoked', { userId, sessionId });

  return { success: true, message: 'Session revoked successfully' };
}

export async function revokeAllOtherSessions(
  userId: string,
  currentRefreshToken: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; count: number; message: string }> {
  const currentHash = hashRefreshToken(currentRefreshToken);

  const result = await prisma.session.updateMany({
    where: {
      userId,
      refreshTokenHash: { not: currentHash },
      isRevoked: false,
    },
    data: { isRevoked: true },
  });

  logAudit({
    userId,
    action: 'session.revoked_all_others',
    resourceType: 'user_session',
    resourceId: userId,
    ipAddress,
    userAgent,
    newData: { revokedCount: result.count },
  });

  logger.info('Revoked all other user sessions', { userId, count: result.count });

  return {
    success: true,
    count: result.count,
    message: `Successfully logged out of ${result.count} other active session(s)`,
  };
}
