import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as invoiceController from '@/controllers/invoice.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/', invoiceController.create);
router.get('/', invoiceController.getAll);
router.get('/:id', invoiceController.getById);
router.put('/:id', invoiceController.update);
router.delete('/:id', invoiceController.remove);

// Lifecycle actions
router.post('/:id/send', invoiceController.send);
router.post('/:id/send-whatsapp', invoiceController.sendByWhatsApp);
router.post('/:id/mark-paid', invoiceController.markPaid);
router.post('/:id/cancel', invoiceController.cancel);

// PDF download
router.get('/:id/pdf', invoiceController.downloadPdf);

export default router;
