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
  'image/jpg',
  'image/pjpeg',
  'image/jfif',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/svg+xml',
  'image/svg',
]);

export const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB

export function isAllowedLogoFile(mimetype?: string, originalname?: string): boolean {
  if (mimetype && ALLOWED_LOGO_MIMES.has(mimetype.toLowerCase())) {
    return true;
  }
  if (originalname) {
    const ext = originalname.split('.').pop()?.toLowerCase();
    if (ext && ['jpg', 'jpeg', 'png', 'webp', 'svg'].includes(ext)) {
      return true;
    }
  }
  return false;
}

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
  // If Cloudinary is configured, attempt upload
  if (config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret) {
    // Delete previous asset first (best-effort, never blocks upload)
    if (oldPublicId && oldPublicId !== 'local_data_uri') {
      try {
        await cloudinary.uploader.destroy(oldPublicId);
        logger.info('Old logo deleted from Cloudinary', { oldPublicId });
      } catch (err) {
        logger.warn('Failed to delete old logo', { oldPublicId, error: err });
      }
    }

    try {
      const result = await new Promise<{ url: string; publicId: string }>((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: `paymytax/logos/${businessId}`,
            resource_type: 'image',
            transformation: [{ width: 800, height: 800, crop: 'limit' }],
          },
          (error, res) => {
            if (error || !res) {
              return reject(error || new Error('Cloudinary returned empty result'));
            }
            resolve({ url: res.secure_url, publicId: res.public_id });
          },
        );
        Readable.from(buffer).pipe(uploadStream);
      });
      return result;
    } catch (err) {
      logger.warn('Cloudinary upload failed, falling back to data URI storage', { error: err, businessId });
    }
  } else {
    logger.info('Cloudinary not configured — using data URI storage for business logo', { businessId });
  }

  // Graceful fallback: Store as Base64 Data URI
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimetype};base64,${base64}`;
  return {
    url: dataUrl,
    publicId: 'local_data_uri',
  };
}

/**
 * Delete a logo by its Cloudinary public_id. Best-effort — never throws.
 */
export async function deleteLogoFromCloudinary(
  publicId: string,
): Promise<void> {
  if (!publicId || publicId === 'local_data_uri') return;
  if (!config.cloudinary.cloudName || !config.cloudinary.apiKey) return;
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
  if (!baseUrl || baseUrl.startsWith('data:')) return baseUrl;
  if (!baseUrl.includes('/image/upload/')) return baseUrl;
  const transforms: Record<string, string> = {
    thumb: 'w_96,h_96,c_fill,g_auto,r_max,f_auto,q_auto',
    dashboard: 'w_200,h_200,c_fill,g_auto,r_max,f_auto,q_auto',
    pdf: 'w_200,h_200,c_fill,g_auto,f_png',
  };
  return baseUrl.replace('/image/upload/', `/image/upload/${transforms[preset]}/`);
}

export default cloudinary;
