import { Router } from 'express';
import { authRateLimiter, passwordResetRateLimiter, bvnRevealRateLimiter } from '@/middleware/security';
import { authenticate } from '@/middleware/auth';
import * as authController from '@/controllers/auth.controller';
import * as pinController from '@/controllers/pin.controller';
import * as sessionController from '@/controllers/session.controller';

const router = Router();

// Rate limiter re-enabled with higher limits for testing
router.post('/register', authRateLimiter, authController.register);
router.post('/login', authRateLimiter, authController.login);
router.post('/refresh', authController.refreshToken);
router.get('/me', authenticate, authController.getMe);
router.patch('/me', authenticate, authController.updateMe);
router.put('/change-password', authenticate, authController.changePassword);
// Dedicated stricter rate limiter for password reset to prevent abuse
router.post('/forgot-password', passwordResetRateLimiter, authController.forgotPassword);
router.post('/reset-password', passwordResetRateLimiter, authController.resetPassword);

// ─── PII Reveal (Authenticated + Strict Rate Limit) ─────────
router.post('/reveal-bvn', authenticate, bvnRevealRateLimiter, authController.revealBvn);

// ─── Transaction PIN Management (Authenticated) ────────────
router.get('/pin/status', authenticate, pinController.getStatus);
router.post('/pin/setup', authenticate, pinController.setup);
router.post('/pin/verify', authenticate, pinController.verify);
router.put('/pin/change', authenticate, pinController.change);

// ─── Multi-Device Session Management (Authenticated) ───────
router.get('/sessions', authenticate, sessionController.listSessions);
router.delete('/sessions/:sessionId', authenticate, sessionController.revokeSession);
router.post('/sessions/revoke-others', authenticate, sessionController.revokeAllOtherSessions);

export default router;
