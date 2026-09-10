import {
  encrypt,
  decrypt,
  computeBlindIndex,
  maskIdentifier,
} from '../../src/lib/crypto';
import {
  putImport,
  getImport,
  dropImport,
  __clearAll,
  __getStoreSize,
  MAX_ENTRIES,
} from '../../src/lib/sales-import/cache';
import { AppError } from '../../src/middleware/errorHandler';

describe('Phase 3 — Regulatory Compliance & KYC Data Protection', () => {
  describe('AES-256-GCM Cryptographic Engine', () => {
    it('should encrypt and decrypt a valid BVN successfully', () => {
      const plainBvn = '22222222221';
      const ciphertext = encrypt(plainBvn);

      expect(ciphertext).toBeDefined();
      expect(ciphertext).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plainBvn);
    });

    it('should encrypt and decrypt a valid 11-digit NIN successfully', () => {
      const plainNin = '12345678901';
      const ciphertext = encrypt(plainNin);

      expect(ciphertext).toMatch(/^enc:v1:/);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plainNin);
    });

    it('should return null when encrypting or decrypting null/undefined/empty inputs', () => {
      expect(encrypt(null)).toBeNull();
      expect(encrypt(undefined)).toBeNull();
      expect(encrypt('')).toBeNull();

      expect(decrypt(null)).toBeNull();
      expect(decrypt(undefined)).toBeNull();
      expect(decrypt('')).toBeNull();
    });

    it('should use randomized IVs so identical plaintexts produce distinct ciphertexts', () => {
      const plain = '22222222221';
      const cipher1 = encrypt(plain);
      const cipher2 = encrypt(plain);

      expect(cipher1).not.toBe(cipher2);
      expect(decrypt(cipher1)).toBe(plain);
      expect(decrypt(cipher2)).toBe(plain);
    });

    it('should throw an AppError if ciphertext or auth tag has been tampered with', () => {
      const plain = '22222222221';
      const ciphertext = encrypt(plain)!;
      const parts = ciphertext.split(':');
      // Tamper with the ciphertext hex byte
      const lastPart = parts[4];
      const corruptedLastPart =
        lastPart.slice(0, -2) + (lastPart.endsWith('aa') ? 'bb' : 'aa');
      parts[4] = corruptedLastPart;
      const tampered = parts.join(':');

      expect(() => decrypt(tampered)).toThrow(AppError);
      expect(() => decrypt(tampered)).toThrow('Cryptographic integrity verification failed');
    });

    it('should gracefully return legacy unencrypted plaintext without failing', () => {
      const legacyBvn = '22222222221';
      expect(decrypt(legacyBvn)).toBe(legacyBvn);
    });
  });

  describe('HMAC-SHA256 Blind Indexing', () => {
    it('should compute a deterministic 64-character hex hash for exact-match lookups', () => {
      const bvn = '22222222221';
      const hash1 = computeBlindIndex(bvn);
      const hash2 = computeBlindIndex(bvn);

      expect(hash1).toBeDefined();
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash1).toBe(hash2);
    });

    it('should normalize input by stripping whitespace and non-digit characters', () => {
      const raw1 = ' 222-222-222 21 ';
      const raw2 = '22222222221';

      expect(computeBlindIndex(raw1)).toBe(computeBlindIndex(raw2));
    });

    it('should produce distinct hashes for distinct inputs', () => {
      const hashA = computeBlindIndex('22222222221');
      const hashB = computeBlindIndex('22222222222');

      expect(hashA).not.toBe(hashB);
    });

    it('should return null for empty or non-digit inputs', () => {
      expect(computeBlindIndex(null)).toBeNull();
      expect(computeBlindIndex(undefined)).toBeNull();
      expect(computeBlindIndex('')).toBeNull();
      expect(computeBlindIndex('---')).toBeNull();
    });
  });

  describe('Identifier Masking', () => {
    it('should mask plaintext identifier to show only last 4 digits', () => {
      expect(maskIdentifier('22222222221')).toBe('•••••2221');
      expect(maskIdentifier('12345678901')).toBe('•••••8901');
    });

    it('should transparently decrypt encrypted identifier before masking', () => {
      const encrypted = encrypt('22222222221');
      expect(maskIdentifier(encrypted)).toBe('•••••2221');
    });

    it('should return short identifiers as-is without masking', () => {
      expect(maskIdentifier('123')).toBe('123');
      expect(maskIdentifier('1234')).toBe('1234');
    });

    it('should return null for empty inputs', () => {
      expect(maskIdentifier(null)).toBeNull();
      expect(maskIdentifier(undefined)).toBeNull();
      expect(maskIdentifier('')).toBeNull();
    });
  });

  describe('Bounded Sales Import Cache (LRU Eviction)', () => {
    beforeEach(() => {
      __clearAll();
    });

    it('should put and get cached import correctly', () => {
      const token = putImport({
        userId: 'u1',
        businessId: 'b1',
        filename: 'sales.xlsx',
        rows: [],
        invalidRows: [],
        duplicateInFile: [],
        duplicateInDb: [],
        lockedMonth: [],
      });

      expect(token).toBeDefined();
      const entry = getImport(token, 'u1', 'b1');
      expect(entry).not.toBeNull();
      expect(entry?.filename).toBe('sales.xlsx');
    });

    it('should reject access if userId or businessId does not match (scope protection)', () => {
      const token = putImport({
        userId: 'u1',
        businessId: 'b1',
        filename: 'sales.xlsx',
        rows: [],
        invalidRows: [],
        duplicateInFile: [],
        duplicateInDb: [],
        lockedMonth: [],
      });

      expect(getImport(token, 'u2', 'b1')).toBeNull();
      expect(getImport(token, 'u1', 'b2')).toBeNull();
    });

    it('should evict the oldest entry (LRU) when store reaches MAX_ENTRIES capacity', () => {
      expect(MAX_ENTRIES).toBe(500);

      // Insert MAX_ENTRIES items
      const firstToken = putImport({
        userId: 'u1',
        businessId: 'b1',
        filename: 'item-0.xlsx',
        rows: [],
        invalidRows: [],
        duplicateInFile: [],
        duplicateInDb: [],
        lockedMonth: [],
      });

      for (let i = 1; i < MAX_ENTRIES; i++) {
        putImport({
          userId: 'u1',
          businessId: 'b1',
          filename: `item-${i}.xlsx`,
          rows: [],
          invalidRows: [],
          duplicateInFile: [],
          duplicateInDb: [],
          lockedMonth: [],
        });
      }

      expect(__getStoreSize()).toBe(MAX_ENTRIES);
      expect(getImport(firstToken, 'u1', 'b1')).not.toBeNull();

      // Now insert one more entry beyond capacity
      const overflowToken = putImport({
        userId: 'u1',
        businessId: 'b1',
        filename: 'overflow.xlsx',
        rows: [],
        invalidRows: [],
        duplicateInFile: [],
        duplicateInDb: [],
        lockedMonth: [],
      });

      // Store size should remain capped at MAX_ENTRIES
      expect(__getStoreSize()).toBe(MAX_ENTRIES);

      // The very first token must have been evicted
      expect(getImport(firstToken, 'u1', 'b1')).toBeNull();

      // The newly added entry must be present
      expect(getImport(overflowToken, 'u1', 'b1')).not.toBeNull();
    });

    it('should drop entry when explicitly deleted', () => {
      const token = putImport({
        userId: 'u1',
        businessId: 'b1',
        filename: 'drop-me.xlsx',
        rows: [],
        invalidRows: [],
        duplicateInFile: [],
        duplicateInDb: [],
        lockedMonth: [],
      });

      expect(getImport(token, 'u1', 'b1')).not.toBeNull();
      dropImport(token);
      expect(getImport(token, 'u1', 'b1')).toBeNull();
    });
  });
});
