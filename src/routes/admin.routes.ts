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

// Payout account change lock (admin-granted one-time permissions)
router.post('/businesses/:businessId/payout-change-permit', adminController.grantPayoutChangePermission);
router.delete('/businesses/:businessId/payout-change-permit', adminController.revokePayoutChangePermission);

// Auto-payout power gate toggle
router.patch('/businesses/:businessId/auto-payout', adminController.toggleBusinessAutoPayout);

// Withdrawal request management (NEW-7 v2: admin-approved withdrawal workflow)
router.get('/settlement/withdrawals', adminController.listWithdrawalRequests);
router.post('/settlement/withdrawals/:id/approve', adminController.approveWithdrawalRequest);
router.post('/settlement/withdrawals/:id/reject', adminController.rejectWithdrawalRequest);
router.post('/settlement/withdrawals/:id/requery', adminController.requeryWithdrawalRequest);

// FIRS remittance tracking & reconciliation
router.get('/remittances/summary', remittanceController.getSummary);
router.get('/remittances', remittanceController.listRemittances);
router.post('/remittances', remittanceController.createBatch);
router.get('/remittances/:id', remittanceController.getRemittance);
router.post('/remittances/:id/record', remittanceController.recordRemittance);

export default router;
