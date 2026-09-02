import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { JWTPayload } from '@/types';
import { RegisterInput, LoginInput, RevealBvnInput } from '@/validators/auth.validator';
import { logAudit } from '@/lib/audit';
import { recordSession, hashRefreshToken } from './session.service';
import { decryptPii } from '@/lib/encryption';
import { assertTransactionAuthorization } from '@/services/pin.service';

// Optimized for small container CPU (0.5 CPU): 10 rounds = ~80ms vs 12 rounds = ~350-600ms
// Industry standard is 10 rounds (2^10 = 1024 iterations), sufficient for 2026 threat model
const BCRYPT_ROUNDS = 10;

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
  const {
    passwordHash,
    transactionPin,
    resetTokenHash,
    bvnEncrypted,
    ninEncrypted,
    bvn,
    nin,
    ...rest
  } = user;
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

export async function login(input: LoginInput, ipAddress?: string, userAgent?: string) {
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

  try {
    await recordSession(user.id, tokens.refreshToken, ipAddress, userAgent);
  } catch (err) {
    logger.warn('Failed to record session during login', { userId: user.id, err });
  }

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

  // Check if the session was explicitly revoked
  const tokenHash = hashRefreshToken(refreshToken);
  const session = await prisma.session.findFirst({
    where: { refreshTokenHash: tokenHash },
  });

  if (session && session.isRevoked) {
    throw new AppError(401, 'Session has been revoked. Please log in again.', 'SESSION_REVOKED');
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
  });

  if (!user || !user.isActive) {
    throw new AppError(401, 'User not found or inactive', 'UNAUTHORIZED');
  }

  if (session) {
    prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date() },
    }).catch(() => {});
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

/**
 * Patch the authenticated user's profile.
 *
 * Phone-only for now — see `updateMeSchema` for the why. The DB has a
 * `@unique` constraint on `phone`, so we pre-check for friendlier errors
 * than the generic P2002 → DUPLICATE_ENTRY mapping (which doesn't tell the
 * user *which* column collided). If two requests race past this check, the
 * DB still rejects the loser — pre-check is for UX, the constraint is the
 * safety net.
 *
 * Audit trail: `user.phone_updated` with old/new last-4 of phone (full
 * number is PII, only diff-traceable digits are logged). Old-phone audit
 * captured *before* the write so a rollback can read it.
 */
export async function updateMe(userId: string, input: { phone: string }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  // No-op if unchanged. Saves a write + an audit row.
  if (user.phone === input.phone) {
    return sanitizeUser(user);
  }

  const existing = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existing && existing.id !== userId) {
    throw new AppError(409, 'That phone number is already in use', 'PHONE_IN_USE');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { phone: input.phone },
  });

  // Fire-and-forget; audit failure must not block the user's profile edit.
  logAudit({
    userId,
    action: 'user.phone_updated',
    resourceType: 'user',
    resourceId: userId,
    oldData: { phoneLast4: user.phone ? user.phone.slice(-4) : null },
    newData: { phoneLast4: input.phone.slice(-4) },
  });

  logger.info('User phone updated', { userId });
  return sanitizeUser(updated);
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
  // Use only the first frontend URL (for dev it's localhost:5173)
  const frontendUrl = config.cors.frontendUrl.split(',')[0].trim();
  const resetLink = `${frontendUrl}/reset-password?token=${rawToken}`;

  // Send password reset email using professional templates
  const { sendEmail } = await import('@/lib/email');
  const { 
    generatePasswordResetHtml, 
    generatePasswordResetText 
  } = await import('@/lib/email/templates/password-reset');

  let emailDelivered = false;
  let resetLinkForDev: string | undefined;

  try {
    const emailResult = await sendEmail({
      to: user.email,
      subject: 'Reset Your PayMyTax Password',
      html: generatePasswordResetHtml({
        resetLink,
        expiryMinutes: RESET_TOKEN_EXPIRY_MINUTES,
        userEmail: user.email,
      }),
      text: generatePasswordResetText({
        resetLink,
        expiryMinutes: RESET_TOKEN_EXPIRY_MINUTES,
        userEmail: user.email,
      }),
    });

    emailDelivered = emailResult.delivered;

    logger.info('Password reset email sent', { 
      userId: user.id, 
      email,
      delivered: emailResult.delivered,
      messageId: emailResult.id,
    });
  } catch (emailError) {
    // Log but don't throw — we don't want to reveal whether email sending
    // succeeded (anti-enumeration). The token is already in the DB, so if
    // email fails, support can manually look up the token hash and help the user.
    logger.error('Password reset email failed to send', {
      userId: user.id,
      email,
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }

  // In development, if email wasn't delivered, return the reset link so frontend can display it
  // This allows testing without email service configuration
  if (config.app.isDevelopment && !emailDelivered) {
    resetLinkForDev = resetLink;
  }

  return { 
    message: 'If an account with that email exists, a password reset link has been sent.',
    resetLink: resetLinkForDev, // Only populated in dev when email fails
  };
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

/**
 * Securely reveals the user's BVN after verifying transaction authorization (PIN or step-up token).
 * Decrypts AES-256-GCM ciphertext stored at rest and logs an audit trail.
 */
export async function revealBvn(
  userId: string,
  cred: RevealBvnInput,
  ipAddress?: string,
  userAgent?: string
): Promise<string> {
  // 1. Authorize via transaction PIN or 5-minute step-up token
  await assertTransactionAuthorization(userId, cred);

  // 2. Fetch encrypted BVN from User model
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, bvnEncrypted: true },
  });

  if (!user) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }

  if (!user.bvnEncrypted) {
    throw new AppError(404, 'BVN has not been registered or verified yet', 'BVN_NOT_FOUND');
  }

  // 3. Decrypt AES-256-GCM ciphertext
  const plaintextBvn = decryptPii(user.bvnEncrypted);

  // 4. Fire-and-forget audit log (never logs the plaintext BVN or ciphertext)
  logAudit({
    userId,
    action: 'user.bvn_revealed',
    resourceType: 'user',
    resourceId: userId,
    ipAddress,
    userAgent,
    newData: { method: cred.stepUpToken ? 'step_up_token' : 'pin' },
  });

  return plaintextBvn;
}
