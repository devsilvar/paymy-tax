import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as creditController from '@/controllers/credit.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/', creditController.create);
router.get('/', creditController.list);
router.get('/summary', creditController.getSummary);
router.get('/:creditId', creditController.getById);
router.patch('/:creditId', creditController.update);
router.post('/:creditId/payments', creditController.recordPayment);
router.post('/:creditId/write-off', creditController.writeOff);
router.post('/:creditId/link-dva/:saleId', creditController.linkDva);
router.post('/:creditId/reconcile-dva/:saleId', creditController.linkDva);
router.post('/:creditId/whatsapp-reminder', creditController.getWhatsAppLink);
router.post('/:creditId/send-whatsapp', creditController.getWhatsAppLink);

export default router;
