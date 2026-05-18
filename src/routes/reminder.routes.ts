import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as reminderController from '@/controllers/reminder.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/generate', reminderController.generate);
router.get('/', reminderController.getAll);
router.get('/active', reminderController.getActive);
router.patch('/:id/mark-sent', reminderController.markSent);
router.delete('/:id', reminderController.dismiss);

export default router;
