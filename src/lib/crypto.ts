import crypto from 'crypto';
import config from '@/config';
import { AppError } from '@/middleware/errorHandler';
import logger from '@/lib/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag
const VERSION_PREFIX = 'enc:v1:';

/**
 * Derives a deterministic 32-byte buffer from any passphrase or secret.
 */
function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Lazy key getters to ensure config is fully loaded.
 */
function getEncryptionKey(): Buffer {
  return deriveKey(config.security.encryptionKey);
}

function getBlindIndexKey(): Buffer {
  return deriveKey(config.security.blindIndexKey);
}

/**
 * Encrypts a plaintext string using AES-256-GCM with a randomized IV.
 * Produces a versioned string format: `enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 *
 * @param text Plaintext to encrypt
 * @returns Serialized ciphertext or null if input is empty
 */
export function encrypt(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === '') {
    return null;
  }

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return `${VERSION_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (err: any) {
    logger.error('Encryption operation failed', { error: err.message });
    throw new AppError(500, 'Failed to securely encrypt sensitive data', 'CRYPTO_ENCRYPTION_ERROR');
  }
}

/**
 * Decrypts an authenticated AES-256-GCM ciphertext.
 *
 * Self-healing: if the text does NOT begin with `enc:v1:`, it is treated
 * as legacy unencrypted plaintext and returned directly without failing.
 *
 * @param encryptedText Serialized ciphertext or legacy plaintext
 * @returns Plaintext string or null if input is empty
 */
export function decrypt(encryptedText: string | null | undefined): string | null {
  if (encryptedText === null || encryptedText === undefined || encryptedText === '') {
    return null;
  }

  // Graceful fallback: legacy unencrypted data returns as-is
  if (!encryptedText.startsWith(VERSION_PREFIX)) {
    return encryptedText;
  }

  try {
    const key = getEncryptionKey();
    const payload = encryptedText.slice(VERSION_PREFIX.length);
    const parts = payload.split(':');

    if (parts.length !== 3) {
      throw new Error('Malformed ciphertext structure');
    }

    const [ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');

    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Invalid IV or auth tag length');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err: any) {
    logger.error('Decryption failed or ciphertext was tampered with', { error: err.message });
    throw new AppError(500, 'Cryptographic integrity verification failed', 'CRYPTO_DECRYPTION_ERROR');
  }
}

/**
 * Computes a deterministic HMAC-SHA256 blind index for exact-match lookups.
 * Strips all non-digit characters to ensure consistent indexing across varying input formats.
 *
 * @param text Sensitive identifier (BVN or NIN)
 * @returns 64-character hex hash or null if input is empty
 */
export function computeBlindIndex(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === '') {
    return null;
  }

  const normalized = text.trim().replace(/\D/g, '');
  if (!normalized) {
    return null;
  }

  const key = getBlindIndexKey();
  return crypto.createHmac('sha256', key).update(normalized).digest('hex');
}

/**
 * Safely masks a sensitive identifier (BVN or NIN) to show only the last 4 characters.
 * Transparently decrypts encrypted values before extracting the last 4 characters.
 *
 * @param text Raw or encrypted identifier
 * @returns Masked string e.g. `•••••1234` or null
 */
export function maskIdentifier(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === '') {
    return null;
  }

  const plain = decrypt(text);
  if (!plain) {
    return null;
  }

  const normalized = plain.trim();
  if (normalized.length <= 4) {
    return normalized;
  }

  return `•••••${normalized.slice(-4)}`;
}
