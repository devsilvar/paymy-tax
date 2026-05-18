import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as businessController from '@/controllers/business.controller';

const router = Router();

router.use(authenticate);

router.post('/', businessController.create);
router.get('/', businessController.getAll);
router.get('/:id', businessController.getById);
router.put('/:id', businessController.update);
router.delete('/:id', businessController.remove);

export default router;
