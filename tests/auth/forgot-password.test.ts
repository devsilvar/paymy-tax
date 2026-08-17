/**
 * Forgot Password Flow Tests
 * 
 * Enterprise-grade test suite covering:
 * - Forgot password request for valid user
 * - Forgot password request for non-existent user (anti-enumeration)
 * - Password reset with valid token
 * - Password reset with expired token
 * - Password reset with invalid token
 * - Rate limiting enforcement
 * - Audit log verification
 */

import request from 'supertest';
import app from '@/app';
import prisma from '@/lib/prisma';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

describe('Forgot Password Flow', () => {
  const testEmail = 'forgot-password-test@example.com';
  const testPassword = 'TestPassword123!';
  let testUserId: string;

  beforeAll(async () => {
    // Create a test user
    const passwordHash = await bcrypt.hash(testPassword, 12);
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        passwordHash,
        phone: '+2341234567890',
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.user.deleteMany({
      where: { email: testEmail },
    });
    await prisma.$disconnect();
  });

  describe('POST /auth/forgot-password', () => {
    it('should accept forgot password request for valid user', async () => {
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: testEmail })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('reset link');

      // Verify token was created in database
      const user = await prisma.user.findUnique({
        where: { email: testEmail },
        select: { resetTokenHash: true, resetTokenExpiresAt: true },
      });

      expect(user?.resetTokenHash).toBeTruthy();
      expect(user?.resetTokenExpiresAt).toBeTruthy();
      expect(user?.resetTokenExpiresAt).toBeInstanceOf(Date);
      expect(user!.resetTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should not reveal if email exists (anti-enumeration)', async () => {
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nonexistent@example.com' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('reset link');
      // Same message as valid user - no enumeration
    });

    it('should validate email format', async () => {
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'invalid-email' })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should require email field', async () => {
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should create audit log for password reset request', async () => {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: testEmail })
        .expect(200);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: testUserId,
          action: 'user.password_reset_requested',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(auditLog).toBeTruthy();
      expect(auditLog?.resourceType).toBe('user');
      expect(auditLog?.resourceId).toBe(testUserId);
    });
  });

  describe('POST /auth/reset-password', () => {
    let validToken: string;
    let tokenHash: string;

    beforeEach(async () => {
      // Generate a fresh token for each test
      validToken = crypto.randomBytes(32).toString('hex');
      tokenHash = crypto.createHash('sha256').update(validToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: testUserId },
        data: {
          resetTokenHash: tokenHash,
          resetTokenExpiresAt: expiresAt,
        },
      });
    });

    it('should reset password with valid token', async () => {
      const newPassword = 'NewSecurePassword456!';

      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('reset successfully');

      // Verify password was changed
      const user = await prisma.user.findUnique({
        where: { id: testUserId },
        select: { passwordHash: true },
      });

      const isNewPasswordValid = await bcrypt.compare(newPassword, user!.passwordHash);
      expect(isNewPasswordValid).toBe(true);

      // Verify token was cleared
      const updatedUser = await prisma.user.findUnique({
        where: { id: testUserId },
        select: { resetTokenHash: true, resetTokenExpiresAt: true },
      });

      expect(updatedUser?.resetTokenHash).toBeNull();
      expect(updatedUser?.resetTokenExpiresAt).toBeNull();
    });

    it('should reject password reset with expired token', async () => {
      // Set token to expired
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          resetTokenExpiresAt: new Date(Date.now() - 1000), // 1 second ago
        },
      });

      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword: 'NewPassword123!',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('INVALID_RESET_TOKEN');
    });

    it('should reject password reset with invalid token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: 'invalid-token-xyz',
          newPassword: 'NewPassword123!',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('INVALID_RESET_TOKEN');
    });

    it('should enforce password strength requirements', async () => {
      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword: 'weak', // Too short
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should create audit log for completed password reset', async () => {
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword: 'NewSecurePassword789!',
        })
        .expect(200);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: testUserId,
          action: 'user.password_reset_completed',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(auditLog).toBeTruthy();
      expect(auditLog?.resourceType).toBe('user');
      expect(auditLog?.resourceId).toBe(testUserId);
    });

    it('should allow login with new password after reset', async () => {
      const newPassword = 'FinalPassword123!';

      // Reset password
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword,
        })
        .expect(200);

      // Try to login with new password
      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testEmail,
          password: newPassword,
        })
        .expect(200);

      expect(loginResponse.body.success).toBe(true);
      expect(loginResponse.body.data.accessToken).toBeTruthy();
      expect(loginResponse.body.data.user.email).toBe(testEmail);
    });

    it('should not allow reuse of the same reset token', async () => {
      const newPassword1 = 'Password1234!';
      const newPassword2 = 'Password5678!';

      // First reset
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword: newPassword1,
        })
        .expect(200);

      // Try to reuse same token
      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: validToken,
          newPassword: newPassword2,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('INVALID_RESET_TOKEN');
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limit on forgot password requests', async () => {
      // The rate limiter allows 3 requests per hour
      const requests = [];

      // Make 4 requests rapidly
      for (let i = 0; i < 4; i++) {
        requests.push(
          request(app)
            .post('/api/v1/auth/forgot-password')
            .send({ email: `test${i}@example.com` })
        );
      }

      const responses = await Promise.all(requests);

      // First 3 should succeed (200)
      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(200);
      expect(responses[2].status).toBe(200);

      // 4th should be rate limited (429)
      expect(responses[3].status).toBe(429);
    }, 10000); // Increase timeout for this test

    it('should enforce rate limit on password reset requests', async () => {
      const requests = [];

      // Make 4 requests rapidly
      for (let i = 0; i < 4; i++) {
        requests.push(
          request(app)
            .post('/api/v1/auth/reset-password')
            .send({
              token: `fake-token-${i}`,
              newPassword: 'FakePassword123!',
            })
        );
      }

      const responses = await Promise.all(requests);

      // First 3 should get to validation (400 for invalid token)
      expect([400, 200]).toContain(responses[0].status);
      expect([400, 200]).toContain(responses[1].status);
      expect([400, 200]).toContain(responses[2].status);

      // 4th should be rate limited (429)
      expect(responses[3].status).toBe(429);
    }, 10000);
  });
});
