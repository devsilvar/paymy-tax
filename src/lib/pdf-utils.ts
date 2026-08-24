/**
 * Fetches a logo from Cloudinary as a PNG buffer for PDFKit embedding.
 * Uses the 'pdf' transform preset (200×200 PNG — forces raster even for SVG uploads).
 * Returns null on ANY failure — PDF generation must NEVER crash because of a logo.
 */
import https from 'https';
import http from 'http';
import { getTransformedLogoUrl } from './cloudinary';
import logger from './logger';

export async function fetchLogoForPdf(logoUrl: string): Promise<Buffer | null> {
  if (!logoUrl) return null;

  const url = getTransformedLogoUrl(logoUrl, 'pdf');

  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 4000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        logger.warn('Logo fetch for PDF returned non-200', {
          status: res.statusCode,
          url,
        });
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', (err) => {
      logger.warn('Logo fetch network error', { error: err.message });
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      logger.warn('Logo fetch timeout (4s)');
      resolve(null);
    });
  });
}
