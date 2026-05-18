import { Router } from 'express';
import * as paymentController from '@/controllers/payment.controller';

const router = Router();

router.post('/paystack', paymentController.handleWebhook);

export default router;
