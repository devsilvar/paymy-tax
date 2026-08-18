import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth';
import * as adminController from '@/controllers/admin.controller';
import * as remittanceController from '@/controllers/firs-remittance.controller';

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticate, authorize('admin'));

router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.listUsers);
router.get('/users/:id', adminController.getUserDetail);
router.patch('/users/:id/status', adminController.toggleUserStatus);
router.patch('/users/:id/email-verification', adminController.toggleEmailVerification);
router.get('/businesses', adminController.listBusinesses);
router.get('/audit-logs', adminController.listAuditLogs);

// FIRS remittance tracking & reconciliation
router.get('/remittances/summary', remittanceController.getSummary);
router.get('/remittances', remittanceController.listRemittances);
router.post('/remittances', remittanceController.createBatch);
router.get('/remittances/:id', remittanceController.getRemittance);
router.post('/remittances/:id/record', remittanceController.recordRemittance);

export default router;
