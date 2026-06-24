import { Router } from 'express';
import { authRateLimiter } from '@/middleware/security';
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
router.post('/forgot-password', authRateLimiter, authController.forgotPassword);
router.post('/reset-password', authRateLimiter, authController.resetPassword);

export default router;
