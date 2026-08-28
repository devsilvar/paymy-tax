import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import * as settlementController from '@/controllers/settlement.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.get('/preview', asyncHandler(settlementController.getPayoutPreview));
router.post('/resolve', asyncHandler(settlementController.resolveAccount));
router.post('/connect', asyncHandler(settlementController.connectBank));
router.post('/withdraw', asyncHandler(settlementController.withdrawBalance));
router.patch('/auto-split', asyncHandler(settlementController.toggleAutoSplit));
router.get('/history', asyncHandler(settlementController.listPayoutHistory));

export default router;
