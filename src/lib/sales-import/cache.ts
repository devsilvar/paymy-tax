/**
 * Sales Import — in-memory preview token cache.
 *
 * Why in-memory instead of Redis/DB?
 *   - Single API process today. Preview → commit is seconds apart in practice.
 *   - Redis is configured but not yet used elsewhere — adding it here would
 *     force us to wire up connection handling for one feature.
 *   - Parsed rows can be large (up to 100 rows * several fields). Persisting
 *     them to DB just to re-read seconds later is wasteful.
 *
 * Caveat: if the API restarts between preview and commit, the user has to
 * re-upload. Acceptable for v1. When we move to multi-instance, this MUST
 * move to Redis — documented in CLAUDE.md Known Limitations.
 *
 * TTL: 15 minutes. Sweeper runs lazily on every set/get so we don't need
 * a persistent interval (which would keep the process alive in tests).
 */
import { randomUUID } from 'crypto';
import { ParsedRow } from './validator';

export interface CachedImport {
  userId: string;
  businessId: string;
  filename: string;
  rows: ParsedRow[];
  // The row-level issues we already computed at preview time.
  // Invalid rows are NOT in `rows` — they're here for display only.
  invalidRows: Array<{ rowNumber: number; errors: Array<{ field: string; message: string }> }>;
  duplicateInFile: number[]; // rowNumbers
  duplicateInDb: number[]; // rowNumbers
  lockedMonth: number[]; // rowNumbers
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const store = new Map<string, CachedImport>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

export function putImport(entry: Omit<CachedImport, 'expiresAt'>): string {
  sweep();
  const token = randomUUID();
  store.set(token, { ...entry, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function getImport(token: string, userId: string, businessId: string): CachedImport | null {
  sweep();
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(token);
    return null;
  }
  // Scope check — a token is only valid for the user+business that created it
  if (entry.userId !== userId || entry.businessId !== businessId) return null;
  return entry;
}

export function dropImport(token: string): void {
  store.delete(token);
}

// Exposed for tests only
export function __clearAll(): void {
  store.clear();
}
