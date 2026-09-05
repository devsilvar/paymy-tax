import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as expenseController from '@/controllers/expense.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.post('/', expenseController.create);
router.get('/', expenseController.getAll);
router.get('/summary', expenseController.summary);
router.get('/daily', expenseController.daily);
router.get('/:id', expenseController.getById);
router.put('/:id', expenseController.update);
router.delete('/:id', expenseController.remove);

export default router;
