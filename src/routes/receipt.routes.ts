import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as receiptController from '@/controllers/receipt.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

// GET /api/v1/businesses/:businessId/receipts/tax-payments/:paymentId
router.get('/tax-payments/:paymentId', receiptController.downloadTaxPaymentReceipt);

// GET /api/v1/businesses/:businessId/receipts/dva-transfers/:saleId
router.get('/dva-transfers/:saleId', receiptController.downloadDvaTransferReceipt);

export default router;
