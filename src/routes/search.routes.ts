import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import * as searchController from '@/controllers/search.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

router.get('/', searchController.search);

export default router;
