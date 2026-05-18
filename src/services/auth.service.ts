import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { JWTPayload } from '@/types';
import { RegisterInput, LoginInput } from '@/validators/auth.validator';
import { logAudit } from '@/lib/audit';

const BCRYPT_ROUNDS = 12;

function generateTokens(payload: { userId: string; email: string; role: string }) {
  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry,
  } as jwt.SignOptions);

  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiry,
  } as jwt.SignOptions);

  return { accessToken, refreshToken };
}

function sanitizeUser(user: any) {
  const { passwordHash, ...rest } = user;
  return rest;
}

export async function register(input: RegisterInput) {
  // Hash outside the transaction — CPU-bound work shouldn't hold a DB lock
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { email: input.email },
    });

    if (existing) {
      throw new AppError(409, 'Email already registered', 'DUPLICATE_EMAIL');
    }

    if (input.phone) {
      const existingPhone = await tx.user.findUnique({
        where: { phone: input.phone },
      });
      if (existingPhone) {
        throw new AppError(409, 'Phone number already registered', 'DUPLICATE_PHONE');
      }
    }

    const created = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        phone: input.phone,
      },
    });

    logAudit({
      userId: created.id,
      action: 'user.registered',
      resourceType: 'user',
      resourceId: created.id,
      newData: { email: created.email },
    }, tx);

    return created;
  });

  const tokens = generateTokens({ userId: user.id, email: user.email, role: user.role });

  logger.info('User registered', { userId: user.id, email: user.email });

  return { user: sanitizeUser(user), ...tokens };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
  });

  if (!user) {
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw new AppError(403, 'Account is deactivated', 'ACCOUNT_DEACTIVATED');
  }

  const isValid = await bcrypt.compare(input.password, user.passwordHash);

  if (!isValid) {
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  // Update lastLoginAt + audit in one transaction
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    logAudit({
      userId: user.id,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id,
    }, tx);
  });

  const tokens = generateTokens({ userId: user.id, email: user.email, role: user.role });

  logger.info('User logged in', { userId: user.id, email: user.email });

  return { user: sanitizeUser(user), ...tokens };
}

export async function refreshAccessToken(refreshToken: string) {
  let decoded: JWTPayload;

  try {
    decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as JWTPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
  });

  if (!user || !user.isActive) {
    throw new AppError(401, 'User not found or inactive', 'UNAUTHORIZED');
  }

  const accessToken = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry } as jwt.SignOptions
  );

  return { accessToken };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  return sanitizeUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);

  if (!isValid) {
    throw new AppError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS');
  }

  // Hash outside the transaction
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    logAudit({
      userId,
      action: 'user.password_changed',
      resourceType: 'user',
      resourceId: userId,
    }, tx);
  });

  logger.info('Password changed', { userId });

  return { message: 'Password changed successfully' };
}

const RESET_TOKEN_EXPIRY_MINUTES = 60;

export async function forgotPassword(email: string) {
  const user = await prisma.user.findUnique({
    where: { email },
  });

  // Always return success to prevent email enumeration
  if (!user) {
    logger.warn('Forgot password requested for non-existent email', { email });
    return { message: 'If an account with that email exists, a password reset link has been sent.' };
  }

  // Generate a secure random token
  const rawToken = crypto.randomBytes(32).toString('hex');
  // Store only the hash in the DB so a DB leak doesn't expose tokens
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: tokenHash,
        resetTokenExpiresAt: expiresAt,
      },
    });

    logAudit({
      userId: user.id,
      action: 'user.password_reset_requested',
      resourceType: 'user',
      resourceId: user.id,
    }, tx);
  });

  // Build the reset link
  const resetLink = `${config.cors.frontendUrl}/reset-password?token=${rawToken}`;

  // ===== DUMMY EMAIL — replace with Resend / your email service =====
  logger.info('PASSWORD RESET EMAIL (dummy)', {
    to: user.email,
    subject: 'Reset your PayMyTax password',
    resetLink,
    expiresInMinutes: RESET_TOKEN_EXPIRY_MINUTES,
  });
  // ==================================================================

  logger.info('Password reset requested', { userId: user.id, email });

  return { message: 'If an account with that email exists, a password reset link has been sent.' };
}

export async function resetPassword(token: string, newPassword: string) {
  // Hash the incoming token to compare against the stored hash
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const user = await prisma.user.findFirst({
    where: {
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: { gt: new Date() },
    },
  });

  if (!user) {
    throw new AppError(400, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN');
  }

  // Hash outside the transaction
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiresAt: null,
      },
    });

    logAudit({
      userId: user.id,
      action: 'user.password_reset_completed',
      resourceType: 'user',
      resourceId: user.id,
    }, tx);
  });

  logger.info('Password reset completed', { userId: user.id });

  return { message: 'Password has been reset successfully. You can now log in with your new password.' };
}
