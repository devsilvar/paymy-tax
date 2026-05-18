/**
 * Sales Import Controller — three handlers:
 *   GET  /template  → streams .xlsx download
 *   POST /preview   → multipart/form-data upload, returns preview JSON
 *   POST /commit    → takes { fileToken }, writes to DB
 */
import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as svc from '@/services/sales-import.service';

// ─── Template download ──────────────────────────────────────

export const template = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const buffer = await svc.buildTemplate(req.user!.userId, req.params.businessId);

  const filename = 'paymytax-sales-import-template.xlsx';
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.status(200).end(buffer);
});

// ─── Preview ────────────────────────────────────────────────
/**
 * Multer (configured in the route file) attaches the uploaded file at req.file.
 * We defensively narrow the type here — if multer isn't wired up right,
 * req.file will be undefined and we fail cleanly.
 */

type MulterRequest = AuthenticatedRequest & {
  file?: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
  };
};

export const preview = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const file = (req as MulterRequest).file;
  if (!file) {
    throw new AppError(400, 'No file uploaded. Attach a .xlsx or .csv file.', 'IMPORT_NO_FILE');
  }

  const result = await svc.previewImport(req.user!.userId, req.params.businessId, {
    buffer: file.buffer,
    mimetype: file.mimetype,
    // sanitize — strip path components in case a proxy didn't
    originalname: file.originalname.replace(/[\\/]/g, '_').slice(0, 255),
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

// ─── Commit ─────────────────────────────────────────────────

const commitSchema = z.object({
  fileToken: z.string().min(1, 'fileToken is required'),
});

export const commit = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { fileToken } = commitSchema.parse(req.body);

  const result = await svc.commitImport(
    req.user!.userId,
    req.params.businessId,
    fileToken
  );

  res.status(200).json({
    success: true,
    data: result,
    message: `Imported ${result.imported} sales.`,
  });
});
