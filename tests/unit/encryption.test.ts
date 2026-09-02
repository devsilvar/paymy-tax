import crypto from 'crypto';
import { encryptPii, decryptPii } from '@/lib/encryption';
import config from '@/config';

describe('AES-256-GCM PII Encryption Utility', () => {
  const originalKey = config.pii.encryptionKey;
  const testKey = crypto.randomBytes(32).toString('base64');

  beforeAll(() => {
    (config.pii as any).encryptionKey = testKey;
    process.env.PII_ENCRYPTION_KEY = testKey;
  });

  afterAll(() => {
    (config.pii as any).encryptionKey = originalKey;
    process.env.PII_ENCRYPTION_KEY = originalKey;
  });

  it('should encrypt and decrypt a valid BVN successfully', () => {
    const rawBvn = '22222222221';
    const encrypted = encryptPii(rawBvn);

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(encrypted).not.toContain(rawBvn);

    const decrypted = decryptPii(encrypted);
    expect(decrypted).toBe(rawBvn);
  });

  it('should produce distinct ciphertexts with different IVs for identical plaintext', () => {
    const rawBvn = '12345678901';
    const cipher1 = encryptPii(rawBvn);
    const cipher2 = encryptPii(rawBvn);

    expect(cipher1).not.toBe(cipher2);
    expect(decryptPii(cipher1)).toBe(rawBvn);
    expect(decryptPii(cipher2)).toBe(rawBvn);
  });

  it('should throw when ciphertext has been tampered with', () => {
    const rawBvn = '22222222221';
    const encrypted = encryptPii(rawBvn);
    const parts = encrypted.split('.');

    // Tamper with the ciphertext payload
    const ctBuffer = Buffer.from(parts[3], 'base64');
    ctBuffer[0] ^= 0xff; // flip bits
    parts[3] = ctBuffer.toString('base64');
    const tampered = parts.join('.');

    expect(() => decryptPii(tampered)).toThrow();
  });

  it('should throw when auth tag has been tampered with', () => {
    const rawBvn = '22222222221';
    const encrypted = encryptPii(rawBvn);
    const parts = encrypted.split('.');

    // Tamper with auth tag
    const tagBuffer = Buffer.from(parts[2], 'base64');
    tagBuffer[0] ^= 0xff;
    parts[2] = tagBuffer.toString('base64');
    const tampered = parts.join('.');

    expect(() => decryptPii(tampered)).toThrow();
  });

  it('should throw when envelope format is malformed or unsupported version', () => {
    expect(() => decryptPii('v2.bad.format')).toThrow();
    expect(() => decryptPii('not-an-envelope')).toThrow();
    expect(() => decryptPii('')).toThrow();
  });

  it('should throw when plaintext is empty', () => {
    expect(() => encryptPii('')).toThrow();
  });

  it('should throw if encryption key is missing or not 32 bytes', () => {
    (config.pii as any).encryptionKey = undefined;
    process.env.PII_ENCRYPTION_KEY = 'invalid-short-key';

    expect(() => encryptPii('12345678901')).toThrow('PII_ENCRYPTION_KEY missing or invalid');

    // Restore test key
    (config.pii as any).encryptionKey = testKey;
    process.env.PII_ENCRYPTION_KEY = testKey;
  });
});
