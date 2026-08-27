import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as ledgerController from '@/controllers/ledger.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

// GET /api/v1/businesses/:businessId/ledger
router.get('/', ledgerController.getLedger);

export default router;
