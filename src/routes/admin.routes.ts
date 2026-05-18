import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth';
import * as adminController from '@/controllers/admin.controller';

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticate, authorize('admin'));

router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.listUsers);
router.get('/users/:id', adminController.getUserDetail);
router.patch('/users/:id/status', adminController.toggleUserStatus);
router.get('/businesses', adminController.listBusinesses);
router.get('/audit-logs', adminController.listAuditLogs);

export default router;
