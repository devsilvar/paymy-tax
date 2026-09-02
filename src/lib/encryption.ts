import crypto from 'crypto';
import config from '@/config';
import { AppError } from '@/middleware/errorHandler';

const GCM_IV_LENGTH = 12; // 12 bytes standard for AES-GCM
const KEY_BYTE_LENGTH = 32; // 32 bytes for AES-256

function getEncryptionKey(): Buffer {
  const rawKey = config.pii.encryptionKey || process.env.PII_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new AppError(
      500,
      'PII_ENCRYPTION_KEY missing or invalid (expected base64 of 32 bytes)',
      'ENCRYPTION_CONFIG_ERROR'
    );
  }

  const keyBuffer = Buffer.from(rawKey, 'base64');
  if (keyBuffer.length !== KEY_BYTE_LENGTH) {
    throw new AppError(
      500,
      'PII_ENCRYPTION_KEY missing or invalid (expected base64 of 32 bytes)',
      'ENCRYPTION_CONFIG_ERROR'
    );
  }

  return keyBuffer;
}

/**
 * Encrypts sensitive PII plaintext using AES-256-GCM with a random 12-byte IV.
 * Returns an envelope string formatted as: `v1.<iv.base64>.<authTag.base64>.<ciphertext.base64>`.
 * 
 * Note: Never logs plaintext, keys, or ciphertexts.
 */
export function encryptPii(plaintext: string): string {
  if (!plaintext) {
    throw new AppError(400, 'Cannot encrypt empty plaintext', 'INVALID_PLAINTEXT');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `v1.${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

/**
 * Decrypts a `v1.<iv>.<authTag>.<ciphertext>` envelope using AES-256-GCM.
 * Validates the authentication tag to ensure data integrity.
 * 
 * Throws on tampering, corrupted envelope, or incorrect key.
 */
export function decryptPii(envelope: string): string {
  if (!envelope || typeof envelope !== 'string') {
    throw new AppError(400, 'Invalid ciphertext format', 'INVALID_CIPHERTEXT');
  }

  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new AppError(400, 'Invalid or unsupported ciphertext format', 'INVALID_CIPHERTEXT');
  }

  const [, ivB64, tagB64, ctB64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');

  if (iv.length !== GCM_IV_LENGTH) {
    throw new AppError(400, 'Invalid IV length in ciphertext envelope', 'INVALID_CIPHERTEXT');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch {
    throw new AppError(500, 'Decryption failed (tampered data or wrong key)', 'DECRYPTION_FAILED');
  }
}
