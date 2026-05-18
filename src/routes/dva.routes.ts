import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as dvaController from '@/controllers/dva.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/setup-virtual-account', dvaController.setupVirtualAccount);
router.post('/validate-customer', dvaController.validateCustomer);
router.get('/virtual-account', dvaController.getVirtualAccount);

export default router;
