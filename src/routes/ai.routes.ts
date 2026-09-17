import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '@/middleware/auth';
import * as aiController from '@/controllers/ai.controller';

const router = Router({ mergeParams: true });

// AI Assistant rate limiter: 25 requests per 15 minutes per authenticated user (or IP fallback)
const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
  message: {
    success: false,
    error: {
      code: 'AI_RATE_LIMIT_EXCEEDED',
      message: 'You have reached the AI question limit (25 questions per 15 minutes). Please wait a few minutes before asking another question.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(aiRateLimiter);

router.post('/chat', aiController.chat);

export default router;
