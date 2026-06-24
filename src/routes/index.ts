/**
 * Main Router
 *
 * Aggregates all API routes and applies versioning.
 *
 * @author WallX Engineering Team
 */

import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import businessRoutes from './business.routes';
import adminRoutes from './admin.routes';
import salesRoutes from './sales.routes';
import expenseRoutes from './expense.routes';
import taxRoutes from './tax.routes';
import reminderRoutes from './reminder.routes';
import paymentRoutes from './payment.routes';
import statementRoutes from './statement.routes';
import webhookRoutes from './webhook.routes';
import dvaRoutes from './dva.routes';
import invoiceRoutes from './invoice.routes';
import searchRoutes from './search.routes';
import publicRoutes from './public.routes';
import bankRoutes from './bank.routes';
import testRoutes from './test.routes';
import transactionClassificationRoutes from './transaction-classification.routes';

const router = Router();

/**
 * Health check routes (no version prefix)
 */
router.use('/health', healthRoutes);

/**
 * API v1 routes
 */
const v1 = Router();
// Public, unauthenticated endpoints. Mounted FIRST so token routes can never
// be shadowed by an authenticated handler defined later.
v1.use('/public', publicRoutes);
v1.use('/auth', authRoutes);
v1.use('/businesses', businessRoutes);
v1.use('/businesses/:businessId/sales', salesRoutes);
v1.use('/businesses/:businessId/expenses', expenseRoutes);
v1.use('/businesses/:businessId/tax', taxRoutes);
v1.use('/businesses/:businessId/tax', paymentRoutes);
v1.use('/businesses/:businessId/tax', statementRoutes);
v1.use('/businesses/:businessId/reminders', reminderRoutes);
v1.use('/businesses/:businessId/dva', dvaRoutes);
v1.use('/businesses/:businessId/invoices', invoiceRoutes);
v1.use('/businesses/:businessId/search', searchRoutes);
v1.use('/banks', bankRoutes);
v1.use('/transaction-classifications', transactionClassificationRoutes);
v1.use('/admin', adminRoutes);

// Test endpoints (dev/test only)
if (process.env.NODE_ENV !== 'production') {
  v1.use('/test', testRoutes);
}

router.use('/v1', v1);

// Webhooks — outside v1, no auth
router.use('/webhooks', webhookRoutes);

export default router;
