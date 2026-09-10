import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import * as walletController from '@/controllers/wallet.controller';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(walletController.getWalletBalance));
router.get('/history', asyncHandler(walletController.getWalletHistory));

export default router;
