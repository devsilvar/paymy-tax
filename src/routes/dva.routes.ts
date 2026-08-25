// import { Router } from 'express';
// import { authenticate } from '@/middleware/auth';
// import * as dvaController from '@/controllers/dva.controller';

// const router = Router({ mergeParams: true });

// router.use(authenticate);

// router.post('/setup-virtual-account', dvaController.setupVirtualAccount);
// router.post('/validate-customer', dvaController.validateCustomer);
// router.get('/virtual-account', dvaController.getVirtualAccount);
// router.post('/requery', dvaController.requery);
// router.post('/settlement/resolve', dvaController.resolveSettlement);
// router.post('/settlement/connect', dvaController.connectSettlement);

// export default router;


import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as dvaController from '@/controllers/dva.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/setup-virtual-account', dvaController.setupVirtualAccount);
router.post('/validate-customer', dvaController.validateCustomer);
router.get('/virtual-account', dvaController.getVirtualAccount);
router.get('/balance', dvaController.getBalance);
router.get('/transactions', dvaController.getDVATransactions);
router.post('/requery', dvaController.requery);
router.post('/settlement/resolve', dvaController.resolveSettlement);
router.post('/settlement/connect', dvaController.connectSettlement);

export default router;