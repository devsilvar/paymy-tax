/**
 * Bank list cache.
 *
 * Wraps Paystack `GET /bank?country=nigeria`. Populates the BVN /
 * bank-account validation dropdown on the frontend (Account.tsx). Banks
 * almost never change, so we cache rows in the `banks` table and refresh
 * lazily — on read, when the newest row's `last_fetched_at` is older than
 * 24 hours.
 *
 * Failure-mode philosophy: if Paystack is unreachable during a refresh, we
 * still return the stale DB rows rather than blocking the BVN form. The
 * worst case is the dropdown shows yesterday's bank list, which is fine
 * because the list virtually never changes. We only surface an error when
 * there are zero rows in the cache *and* Paystack is unreachable —
 * meaningfully nothing to show.
 *
 * Concurrency: two simultaneous requests during a stale window will both
 * trigger a Paystack call. That's fine — `upsertMany` (handled as
 * per-row upserts inside a transaction) is idempotent on the unique `slug`
 * key. We could add an in-process mutex but it would just hide the second
 * Paystack call without changing correctness; not worth the complexity for
 * a once-per-day path.
 */
import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { getPaymentProvider } from '@/lib/payment';
import { BankRecord } from '@/lib/payment/types';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_COUNTRY = 'nigeria';

/**
 * Public surface — what callers (controllers, services) get back. Drops
 * internal columns (createdAt/updatedAt/lastFetchedAt) to keep the API
 * response lean.
 */
export interface BankDto {
  id: string;
  code: string;
  name: string;
  slug: string;
  longCode: string | null;
  type: string | null;
  active: boolean;
}

function toDto(row: {
  id: string;
  code: string;
  name: string;
  slug: string;
  longCode: string | null;
  type: string | null;
  active: boolean;
}): BankDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    slug: row.slug,
    longCode: row.longCode,
    type: row.type,
    active: row.active,
  };
}

/**
 * Check whether the cache needs a refresh. Returns true if the newest row's
 * `lastFetchedAt` is older than `STALE_AFTER_MS`, or if there are no rows
 * at all.
 */
async function cacheIsStale(country: string): Promise<boolean> {
  const newest = await prisma.bank.findFirst({
    // Case-insensitive: cached rows may have mixed casing ("Nigeria" vs
    // "nigeria") from before we canonicalised to lowercase. Matching only the
    // exact-case param previously wedged this on a single stray row.
    where: { country: { equals: country, mode: 'insensitive' } },
    orderBy: { lastFetchedAt: 'desc' },
    select: { lastFetchedAt: true },
  });

  if (!newest) return true;
  return Date.now() - newest.lastFetchedAt.getTime() > STALE_AFTER_MS;
}

/**
 * Pull a fresh list from Paystack and upsert into the cache. Returns nothing
 * — caller re-reads from the DB. Wrapped in try/catch by `listBanks` so a
 * refresh failure never breaks the read path when stale rows exist.
 */
async function refreshFromProvider(country: string): Promise<void> {
  const provider = getPaymentProvider();
  const banks: BankRecord[] = await provider.listBanks(country);

  if (banks.length === 0) {
    logger.warn('Paystack returned zero banks — skipping cache update', { country });
    return;
  }

  // Per-row upsert keyed on `slug` (the Paystack identifier). We rebuild
  // `lastFetchedAt` on every refresh so `cacheIsStale` works off whichever
  // row was touched most recently.
  await prisma.$transaction(
    banks.map((b) =>
      prisma.bank.upsert({
        where: { slug: b.slug },
        create: {
          code: b.code,
          name: b.name,
          slug: b.slug,
          longCode: b.longCode ?? null,
          country: (b.country ?? country).toLowerCase(),
          currency: b.currency ?? 'NGN',
          type: b.type ?? null,
          active: b.active,
        },
        update: {
          code: b.code,
          name: b.name,
          longCode: b.longCode ?? null,
          country: (b.country ?? country).toLowerCase(),
          currency: b.currency ?? 'NGN',
          type: b.type ?? null,
          active: b.active,
          lastFetchedAt: new Date(),
        },
      }),
    ),
  );

  logger.info('Bank cache refreshed from Paystack', { country, count: banks.length });
}

/**
 * Return the cached list of banks for a country, refreshing from Paystack if
 * stale. Filter to `active=true` so the dropdown never shows decommissioned
 * banks. Sorted alphabetically by name (UI expects this).
 */
export async function listBanks(country = DEFAULT_COUNTRY): Promise<BankDto[]> {
  if (await cacheIsStale(country)) {
    try {
      await refreshFromProvider(country);
    } catch (err) {
      // If Paystack is unreachable, fall back to whatever's in the cache.
      // Only surface as an error if there are zero rows AND Paystack failed
      // — see check below.
      logger.warn('Bank cache refresh failed — using stale rows', {
        country,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rows = await prisma.bank.findMany({
    // Case-insensitive country match — see cacheIsStale for why. Without this
    // a "Nigeria"/"nigeria" casing split silently hides every row whose casing
    // differs from the param (the Sparkle-only-dropdown bug).
    where: { country: { equals: country, mode: 'insensitive' }, active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      slug: true,
      longCode: true,
      type: true,
      active: true,
    },
  });

  if (rows.length === 0) {
    throw new AppError(
      503,
      'Bank list is currently unavailable — please retry in a moment',
      'BANK_LIST_UNAVAILABLE',
    );
  }

  return rows.map(toDto);
}

/**
 * Look up a single bank by its Paystack slug or NIBSS code. Used by the BVN
 * validation flow to translate the dropdown selection into the `bank_code`
 * Paystack expects on `/customer/:code/identification`.
 */
export async function findBankByCodeOrSlug(value: string): Promise<BankDto | null> {
  const row = await prisma.bank.findFirst({
    where: {
      OR: [{ slug: value }, { code: value }],
    },
    select: {
      id: true,
      code: true,
      name: true,
      slug: true,
      longCode: true,
      type: true,
      active: true,
    },
  });

  return row ? toDto(row) : null;
}
