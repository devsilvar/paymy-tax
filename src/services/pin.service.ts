import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma';
import config from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { SetupPinInput, ChangePinInput } from '@/validators/pin.validator';

const BCRYPT_ROUNDS = 12;

/**
 * Issues a short-lived (5-minute) step-up token upon successful PIN verification.
 */
export function issueStepUpToken(userId: string): string {
  return jwt.sign(
    { sub: userId, type: 'pin_step_up' },
    config.jwt.accessSecret,
    { expiresIn: '5m' }
  );
}

/**
 * Verifies a step-up token ensuring it is valid, not expired, belongs to the user,
 * and carries the correct pin_step_up type discriminator.
 */
export function verifyStepUpToken(userId: string, token: string): void {
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret) as jwt.JwtPayload;
    if (payload.type !== 'pin_step_up' || payload.sub !== userId) {
      throw new AppError(401, 'Invalid or expired step-up authorization token', 'INVALID_STEP_UP_TOKEN');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'Invalid or expired step-up authorization token', 'INVALID_STEP_UP_TOKEN');
  }
}

/**
 * Dual-accept authorization helper for sensitive money mutations.
 * Accepts either a valid stepUpToken or raw PIN (retaining e2e test backward compatibility).
 */
export async function assertTransactionAuthorization(
  userId: string,
  cred: { pin?: string; stepUpToken?: string }
): Promise<void> {
  if (cred.stepUpToken) {
    verifyStepUpToken(userId, cred.stepUpToken);
    return;
  }
  if (cred.pin) {
    await verifyPin(userId, cred.pin);
    return;
  }
  throw new AppError(400, 'Transaction PIN or step-up token is required', 'MISSING_PIN_CREDENTIAL');
}

export interface PinStatusResponse {
  hasPin: boolean;
  isLocked: boolean;
  lockedUntil?: string;
  remainingAttempts: number;
  attemptsResetAt?: string;
  pinSetAt?: string;
}

export async function getPinStatus(userId: string): Promise<PinStatusResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      transactionPin: true,
      pinAttempts: true,
      pinLockedUntil: true,
      pinAttemptsResetAt: true,
      pinSetAt: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const now = new Date();
  const isLocked = Boolean(user.pinLockedUntil && user.pinLockedUntil > now);
  const windowExpired = !user.pinAttemptsResetAt || user.pinAttemptsResetAt <= now;
  const currentAttempts = windowExpired ? 0 : user.pinAttempts;

  return {
    hasPin: Boolean(user.transactionPin),
    isLocked,
    lockedUntil: isLocked && user.pinLockedUntil ? user.pinLockedUntil.toISOString() : undefined,
    remainingAttempts: isLocked ? 0 : Math.max(0, config.pin.maxAttempts - currentAttempts),
    attemptsResetAt: !isLocked && user.pinAttemptsResetAt && !windowExpired ? user.pinAttemptsResetAt.toISOString() : undefined,
    pinSetAt: user.pinSetAt ? user.pinSetAt.toISOString() : undefined,
  };
}

export async function setupPin(
  userId: string,
  input: SetupPinInput,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; message: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, transactionPin: true },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (user.transactionPin) {
    throw new AppError(409, 'Transaction PIN is already set. Use change PIN instead.', 'PIN_ALREADY_SET');
  }

  // Verify password before hashing PIN
  const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!isPasswordValid) {
    throw new AppError(401, 'Account password is incorrect', 'INVALID_PASSWORD');
  }

  // Hash PIN outside DB transaction
  const pinHash = await bcrypt.hash(input.pin, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: userId },
    data: {
      transactionPin: pinHash,
      pinSetAt: new Date(),
      pinAttempts: 0,
      pinLockedUntil: null,
      pinAttemptsResetAt: null,
    },
  });

  logAudit({
    userId,
    action: 'user.pin_set',
    resourceType: 'user_security',
    resourceId: userId,
    ipAddress,
    userAgent,
    newData: { pinSetAt: new Date().toISOString() },
  });

  logger.info('Transaction PIN configured successfully', { userId });

  return { success: true, message: 'Transaction PIN set successfully' };
}

export async function verifyPin(
  userId: string,
  pin: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ valid: boolean; stepUpToken: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      transactionPin: true,
      pinAttempts: true,
      pinLockedUntil: true,
      pinAttemptsResetAt: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (!user.transactionPin) {
    throw new AppError(400, 'Transaction PIN has not been set up yet', 'PIN_NOT_SET');
  }

  const now = new Date();
  if (user.pinLockedUntil && user.pinLockedUntil > now) {
    const lockedUntilFormatted = user.pinLockedUntil.toLocaleString('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const remainingMinutes = Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / (60 * 1000));
    throw new AppError(
      423,
      `Transaction PIN is temporarily locked. Locked until ${lockedUntilFormatted}. You can reset it now from Settings → Security using your password.`,
      'PIN_LOCKED',
      { remainingMinutes, lockedUntil: user.pinLockedUntil }
    );
  }

  // Compare PIN hash
  const isValid = await bcrypt.compare(pin, user.transactionPin);

  if (!isValid) {
    const windowExpired = !user.pinAttemptsResetAt || user.pinAttemptsResetAt <= now;
    const newAttempts = windowExpired ? 1 : user.pinAttempts + 1;
    const resetAt = windowExpired
      ? new Date(now.getTime() + config.pin.attemptWindowHours * 60 * 60 * 1000)
      : user.pinAttemptsResetAt;
    const isNowLocked = newAttempts >= config.pin.maxAttempts;
    const lockedUntil = isNowLocked ? resetAt : null;

    await prisma.user.update({
      where: { id: userId },
      data: {
        pinAttempts: newAttempts,
        pinLockedUntil: lockedUntil,
        pinAttemptsResetAt: resetAt,
      },
    });

    logAudit({
      userId,
      action: isNowLocked ? 'user.pin_locked' : 'user.pin_failed',
      resourceType: 'user_security',
      resourceId: userId,
      ipAddress,
      userAgent,
      newData: { attempts: newAttempts, isLocked: isNowLocked, lockedUntil: lockedUntil?.toISOString() },
    });

    if (isNowLocked) {
      const resetAtFormatted = resetAt.toLocaleString('en-NG', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      throw new AppError(
        423,
        `Too many incorrect PIN attempts. Your PIN is locked until ${resetAtFormatted}. You can reset it now from Settings → Security using your password.`,
        'PIN_LOCKED',
        { remainingMinutes: Math.ceil((resetAt.getTime() - now.getTime()) / (60 * 1000)), lockedUntil: resetAt }
      );
    }

    const remaining = config.pin.maxAttempts - newAttempts;
    throw new AppError(
      401,
      `Incorrect transaction PIN. ${remaining} attempt(s) remaining before account lockout.`,
      'INVALID_PIN',
      { remainingAttempts: remaining }
    );
  }

  // Reset attempt counter and lockout on success
  if (user.pinAttempts > 0 || user.pinLockedUntil || user.pinAttemptsResetAt) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        pinAttempts: 0,
        pinLockedUntil: null,
        pinAttemptsResetAt: null,
      },
    });
  }

  const stepUpToken = issueStepUpToken(userId);
  return { valid: true, stepUpToken };
}

export async function changePin(
  userId: string,
  input: ChangePinInput,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; message: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      passwordHash: true,
      transactionPin: true,
      pinAttempts: true,
      pinLockedUntil: true,
      pinAttemptsResetAt: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (!user.transactionPin) {
    throw new AppError(400, 'Transaction PIN has not been set yet. Use setup PIN instead.', 'PIN_NOT_SET');
  }

  const now = new Date();
  if (user.pinLockedUntil && user.pinLockedUntil > now) {
    const lockedUntilFormatted = user.pinLockedUntil.toLocaleString('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const remainingMinutes = Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / (60 * 1000));
    throw new AppError(
      423,
      `Transaction PIN is temporarily locked. Locked until ${lockedUntilFormatted}. You can reset it now from Settings → Security using your password.`,
      'PIN_LOCKED',
      { remainingMinutes, lockedUntil: user.pinLockedUntil }
    );
  }

  // Authorization check (either current PIN or account password)
  if (input.currentPin) {
    const isPinValid = await bcrypt.compare(input.currentPin, user.transactionPin);
    if (!isPinValid) {
      const windowExpired = !user.pinAttemptsResetAt || user.pinAttemptsResetAt <= now;
      const newAttempts = windowExpired ? 1 : user.pinAttempts + 1;
      const resetAt = windowExpired
        ? new Date(now.getTime() + config.pin.attemptWindowHours * 60 * 60 * 1000)
        : user.pinAttemptsResetAt;
      const isNowLocked = newAttempts >= config.pin.maxAttempts;
      const lockedUntil = isNowLocked ? resetAt : null;

      await prisma.user.update({
        where: { id: userId },
        data: {
          pinAttempts: newAttempts,
          pinLockedUntil: lockedUntil,
          pinAttemptsResetAt: resetAt,
        },
      });

      logAudit({
        userId,
        action: isNowLocked ? 'user.pin_locked' : 'user.pin_failed',
        resourceType: 'user_security',
        resourceId: userId,
        ipAddress,
        userAgent,
        newData: { attempts: newAttempts, isLocked: isNowLocked, lockedUntil: lockedUntil?.toISOString() },
      });

      if (isNowLocked) {
        const resetAtFormatted = resetAt.toLocaleString('en-NG', {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
        throw new AppError(
          423,
          `Too many incorrect PIN attempts. Your PIN is locked until ${resetAtFormatted}. You can reset it now from Settings → Security using your password.`,
          'PIN_LOCKED',
          { remainingMinutes: Math.ceil((resetAt.getTime() - now.getTime()) / (60 * 1000)), lockedUntil: resetAt }
        );
      }

      const remaining = config.pin.maxAttempts - newAttempts;
      throw new AppError(
        401,
        `Current transaction PIN is incorrect. ${remaining} attempt(s) remaining before account lockout.`,
        'INVALID_PIN',
        { remainingAttempts: remaining }
      );
    }
  } else if (input.password) {
    const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError(401, 'Account password is incorrect', 'INVALID_PASSWORD');
    }
  }

  // Hash new PIN outside DB transaction
  const newPinHash = await bcrypt.hash(input.newPin, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: userId },
    data: {
      transactionPin: newPinHash,
      pinSetAt: new Date(),
      pinAttempts: 0,
      pinLockedUntil: null,
      pinAttemptsResetAt: null,
    },
  });

  logAudit({
    userId,
    action: 'user.pin_changed',
    resourceType: 'user_security',
    resourceId: userId,
    ipAddress,
    userAgent,
    newData: { pinSetAt: new Date().toISOString() },
  });

  logger.info('Transaction PIN changed successfully', { userId });

  return { success: true, message: 'Transaction PIN changed successfully' };
}
