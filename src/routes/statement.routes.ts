import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as statementController from '@/controllers/statement.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

// GET /api/v1/businesses/:businessId/tax/statements/monthly?month=3&year=2026
router.get('/statements/monthly', statementController.downloadMonthly);

// GET /api/v1/businesses/:businessId/tax/statements/period?startMonth=1&startYear=2026&endMonth=6&endYear=2026
router.get('/statements/period', statementController.downloadPeriod);

export default router;
