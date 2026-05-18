/**
 * Public, unauthenticated routes.
 *
 * Mounted at /api/v1/public — sibling to authenticated /api/v1/* routes.
 * Anything here is reachable by a recipient who only has a share token; it
 * MUST NOT leak data beyond what the SME has explicitly chosen to share.
 */

import { Router } from 'express';
import * as invoiceController from '@/controllers/invoice.controller';

const router = Router();

// Customer-facing invoice PDF. The token in the URL substitutes for auth.
router.get('/invoices/:token/pdf', invoiceController.downloadPublicPdf);

export default router;
