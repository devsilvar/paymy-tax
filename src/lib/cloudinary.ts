/**
 * Cloudinary upload / delete / transform wrapper.
 *
 * Logos are stored under `paymytax/logos/<businessId>/`.
 * On-the-fly transforms via URL rewriting (no sharp dependency).
 */
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import config from '@/config';
import { AppError } from '@/middleware/errorHandler';
import logger from './logger';

// ── Configure once at module load ───────────────────────────
cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
});

export const ALLOWED_LOGO_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
]);

export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Upload a logo buffer to Cloudinary via streaming.
 * Deletes the previous logo if `oldPublicId` is supplied.
 */
export async function uploadLogoToCloudinary(
  businessId: string,
  buffer: Buffer,
  mimetype: string,
  oldPublicId?: string | null,
): Promise<{ url: string; publicId: string }> {
  if (!config.cloudinary.cloudName || !config.cloudinary.apiKey) {
    throw new AppError(
      500,
      'Cloudinary is not configured on the server. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      'STORAGE_CONFIG_ERROR',
    );
  }

  // Delete previous asset first (best-effort, never blocks upload)
  if (oldPublicId) {
    try {
      await cloudinary.uploader.destroy(oldPublicId);
      logger.info('Old logo deleted from Cloudinary', { oldPublicId });
    } catch (err) {
      logger.warn('Failed to delete old logo', { oldPublicId, error: err });
    }
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `paymytax/logos/${businessId}`,
        resource_type: 'image',
        transformation: [{ width: 800, height: 800, crop: 'limit' }],
      },
      (error, result) => {
        if (error || !result) {
          logger.error('Cloudinary upload failed', { error, businessId });
          return reject(
            new AppError(500, 'Failed to upload logo to Cloudinary.', 'UPLOAD_FAILED'),
          );
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    Readable.from(buffer).pipe(uploadStream);
  });
}

/**
 * Delete a logo by its Cloudinary public_id. Best-effort — never throws.
 */
export async function deleteLogoFromCloudinary(
  publicId: string,
): Promise<void> {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
    logger.info('Logo deleted from Cloudinary', { publicId });
  } catch (err) {
    logger.warn('Logo delete failed', { publicId, error: err });
  }
}

/**
 * Build a Cloudinary transform URL for a given use case.
 *
 * Inserts transforms between `/upload/` and the version segment:
 *   https://res.cloudinary.com/<cloud>/image/upload/<TRANSFORMS>/v.../file.jpg
 */
export function getTransformedLogoUrl(
  baseUrl: string,
  preset: 'thumb' | 'dashboard' | 'pdf',
): string {
  if (!baseUrl?.includes('/image/upload/')) return baseUrl;
  const transforms: Record<string, string> = {
    thumb: 'w_96,h_96,c_fill,g_auto,r_max,f_auto,q_auto',
    dashboard: 'w_200,h_200,c_fill,g_auto,r_max,f_auto,q_auto',
    pdf: 'w_200,h_200,c_fill,g_auto,f_png',
  };
  return baseUrl.replace('/image/upload/', `/image/upload/${transforms[preset]}/`);
}

export default cloudinary;
