import { Router } from 'express';
import * as classificationController from '@/controllers/transaction-classification.controller';
import { authenticate } from '@/middleware/auth';

const router = Router();

/**
 * GET /transaction-classifications
 * Get all active classifications
 */
router.get('/', authenticate, classificationController.getClassifications);

/**
 * GET /transaction-classifications/revenue
 * Get revenue classifications only
 */
router.get('/revenue', authenticate, classificationController.getRevenueClassifications);

/**
 * GET /transaction-classifications/category/:category
 * Get classifications by category
 */
router.get('/category/:category', authenticate, classificationController.getClassificationsByCategory);

export default router;
