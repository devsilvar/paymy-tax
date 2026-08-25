import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '@/middleware/auth';
import { AppError } from '@/middleware/errorHandler';
import * as salesController from '@/controllers/sales.controller';
import * as salesImportController from '@/controllers/sales-import.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

// ─── Sales CRUD ─────────────────────────────────────────────

router.post('/', salesController.create);
router.get('/', salesController.getAll);
router.get('/overview', salesController.getOverview);
router.get('/summary', salesController.summary);
router.get('/unverified', salesController.getUnverified);


// ─── Sales Import (Excel / CSV) ─────────────────────────────
//
// Multer in-memory storage is intentional — we parse the file buffer
// directly and never persist it. Size is capped at 2 MB which is plenty
// for our 100-row limit; anything larger is refused at the middleware
// level before the parser gets involved.
//
// Accept both xlsx and csv. xls (legacy binary) is rejected because
// exceljs doesn't read it reliably — users can re-save as .xlsx.

const ACCEPTED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // some clients send this for .xlsx; we'll still try
  'text/csv',
  'application/csv',
  'application/octet-stream', // Windows sometimes sends this — fall through to ext check
]);

const uploadSalesFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop() ?? '';
    if (ext !== 'xlsx' && ext !== 'csv') {
      return cb(
        new AppError(
          400,
          'Only .xlsx and .csv files are accepted.',
          'IMPORT_BAD_EXTENSION'
        )
      );
    }
    if (!ACCEPTED_MIMES.has(file.mimetype)) {
      // Permit mime mismatches only when extension is good — Windows lies.
      // We've already gated on extension above, so this is informational.
    }
    cb(null, true);
  },
});

// Place import routes BEFORE the dynamic :id route — otherwise Express
// will try to match '/import/template' as GET /:id.
router.get('/import/template', salesImportController.template);
router.post(
  '/import/preview',
  uploadSalesFile.single('file'),
  salesImportController.preview
);
router.post('/import/commit', salesImportController.commit);

// ─── Dynamic routes (must come last) ────────────────────────

router.get('/:id', salesController.getById);
router.put('/:id', salesController.update);
router.delete('/:id', salesController.remove);
router.post('/:id/verify', salesController.verify);
router.post('/:id/reclassify', salesController.reclassify);

export default router;
