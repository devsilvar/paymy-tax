import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { paymentRateLimiter } from '@/middleware/security';
import * as paymentController from '@/controllers/payment.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/pay', paymentRateLimiter, paymentController.initiatePayment);
router.get('/payments', paymentController.listPayments);
router.get('/payments/:paymentId', paymentController.getPayment);
router.get('/payments/:paymentId/verify', paymentController.verifyPayment);
router.post('/payments/:paymentId/abandon', paymentController.abandonPayment);

export default router;
