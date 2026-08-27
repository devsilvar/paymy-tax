import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma';
import config from '@/config';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { logAudit } from '@/lib/audit';
import { SetupPinInput, ChangePinInput } from '@/validators/pin.validator';

const MAX_PIN_ATTEMPTS = 3;
const PIN_LOCKOUT_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

export interface PinStatusResponse {
  hasPin: boolean;
  isLocked: boolean;
  lockedUntil?: string;
  remainingAttempts: number;
  pinSetAt?: string;
}

export async function getPinStatus(userId: string): Promise<PinStatusResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      transactionPin: true,
      pinAttempts: true,
      pinLockedUntil: true,
      pinSetAt: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const now = new Date();
  const isLocked = Boolean(user.pinLockedUntil && user.pinLockedUntil > now);

  return {
    hasPin: Boolean(user.transactionPin),
    isLocked,
    lockedUntil: isLocked && user.pinLockedUntil ? user.pinLockedUntil.toISOString() : undefined,
    remainingAttempts: isLocked ? 0 : Math.max(0, MAX_PIN_ATTEMPTS - user.pinAttempts),
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
    const remainingMinutes = Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / (60 * 1000));
    throw new AppError(
      423,
      `Transaction PIN is temporarily locked due to multiple failed attempts. Try again in ${remainingMinutes} minute(s).`,
      'PIN_LOCKED',
      { remainingMinutes, lockedUntil: user.pinLockedUntil }
    );
  }

  // Compare PIN hash
  const isValid = await bcrypt.compare(pin, user.transactionPin);

  if (!isValid) {
    const newAttempts = user.pinAttempts + 1;
    const isNowLocked = newAttempts >= MAX_PIN_ATTEMPTS;
    const lockedUntil = isNowLocked ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000) : null;

    await prisma.user.update({
      where: { id: userId },
      data: {
        pinAttempts: newAttempts,
        pinLockedUntil: lockedUntil,
      },
    });

    logAudit({
      userId,
      action: isNowLocked ? 'user.pin_locked' : 'user.pin_failed',
      resourceType: 'user_security',
      resourceId: userId,
      ipAddress,
      userAgent,
      newData: { attempts: newAttempts, isLocked: isNowLocked },
    });

    if (isNowLocked) {
      throw new AppError(
        423,
        `Too many incorrect PIN attempts. Your transaction PIN is locked for ${PIN_LOCKOUT_MINUTES} minutes.`,
        'PIN_LOCKED',
        { remainingMinutes: PIN_LOCKOUT_MINUTES, lockedUntil }
      );
    }

    const remaining = MAX_PIN_ATTEMPTS - newAttempts;
    throw new AppError(
      401,
      `Incorrect transaction PIN. ${remaining} attempt(s) remaining before account lockout.`,
      'INVALID_PIN',
      { remainingAttempts: remaining }
    );
  }

  // Reset attempt counter on success if needed
  if (user.pinAttempts > 0 || user.pinLockedUntil) {
    await prisma.user.update({
      where: { id: userId },
      data: { pinAttempts: 0, pinLockedUntil: null },
    });
  }

  // Issue 5-minute ephemeral step-up token
  const stepUpToken = jwt.sign(
    {
      userId: user.id,
      type: 'pin_step_up',
    },
    config.jwt.accessSecret,
    { expiresIn: '5m' }
  );

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
    const remainingMinutes = Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / (60 * 1000));
    throw new AppError(
      423,
      `Transaction PIN is temporarily locked. Try again in ${remainingMinutes} minute(s).`,
      'PIN_LOCKED'
    );
  }

  // Authorization check (either current PIN or account password)
  if (input.currentPin) {
    const isPinValid = await bcrypt.compare(input.currentPin, user.transactionPin);
    if (!isPinValid) {
      const newAttempts = user.pinAttempts + 1;
      const isNowLocked = newAttempts >= MAX_PIN_ATTEMPTS;
      const lockedUntil = isNowLocked ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000) : null;

      await prisma.user.update({
        where: { id: userId },
        data: { pinAttempts: newAttempts, pinLockedUntil: lockedUntil },
      });

      if (isNowLocked) {
        throw new AppError(
          423,
          `Too many incorrect PIN attempts. Locked for ${PIN_LOCKOUT_MINUTES} minutes.`,
          'PIN_LOCKED'
        );
      }

      throw new AppError(
        401,
        `Current transaction PIN is incorrect. ${MAX_PIN_ATTEMPTS - newAttempts} attempt(s) remaining.`,
        'INVALID_PIN'
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
