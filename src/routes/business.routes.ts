import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '@/middleware/auth';
import { AppError } from '@/middleware/errorHandler';
import { ALLOWED_LOGO_MIMES, MAX_LOGO_BYTES } from '@/lib/cloudinary';
import * as businessController from '@/controllers/business.controller';

const router = Router();

router.use(authenticate);

// ── Multer for logo uploads ──
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_LOGO_MIMES.has(file.mimetype)) {
      return cb(
        new AppError(400, 'Only JPEG, PNG, WebP or SVG images are accepted.', 'LOGO_BAD_TYPE'),
      );
    }
    cb(null, true);
  },
});

router.post('/', businessController.create);
router.get('/', businessController.getAll);
router.get('/:id', businessController.getById);
router.put('/:id', businessController.update);
router.delete('/:id', businessController.remove);

// ── Logo routes ──
router.post('/:id/logo', logoUpload.single('logo'), businessController.uploadLogo);
router.delete('/:id/logo', businessController.deleteLogo);

export default router;

