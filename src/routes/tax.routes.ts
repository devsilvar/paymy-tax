import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as taxController from '@/controllers/tax.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/calculate', taxController.calculate);
router.get('/reports', taxController.listReports);
router.get('/reports/:id', taxController.getReport);
router.post('/reports/:id/finalize', taxController.finalize);
router.post('/reports/:id/unfinalize', taxController.unfinalize);
router.get('/dashboard', taxController.dashboard);
router.get('/analytics', taxController.analytics);

export default router;
