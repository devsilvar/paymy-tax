import { Router } from 'express';
import { authRateLimiter, passwordResetRateLimiter } from '@/middleware/security';
import { authenticate } from '@/middleware/auth';
import * as authController from '@/controllers/auth.controller';

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

export default router;
