/**
 * Bank list route.
 *
 * Mounted at `/api/v1/banks`. Returns the cached Paystack bank list so the
 * frontend BVN-validation dropdown can populate. See bank.service.ts for the
 * 24h refresh strategy.
 */
import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as bankController from '@/controllers/bank.controller';

const router = Router();

router.use(authenticate);

router.get('/', bankController.listBanks);

export default router;
