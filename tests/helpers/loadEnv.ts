// Jest setup file — loads .env before tests run so signatures match
import 'dotenv/config';

// ─── Test-database isolation ─────────────────────────────────────────────────
// When TEST_DATABASE_URL is set, REDIRECT the entire test process to it —
// including `src/lib/prisma` (used by createApp() in e2e tests), which
// otherwise follows DATABASE_URL. This is what lets the live database live
// on Railway while tests run against Supabase (or any dedicated test DB):
//
//   DATABASE_URL / DIRECT_URL  →  Railway (live data — tests NEVER touch it)
//   TEST_DATABASE_URL          →  Supabase (sacrificial test database)
//
// Must happen in setupFiles (runs before any test module import), because
// PrismaClient and src/config read env vars at import time.
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL) {
  // If TEST_DATABASE_URL is identical to DATABASE_URL or points to the exact same host/db
  const origHost = ORIGINAL_DATABASE_URL?.split('@')[1]?.split('/')[0] ?? '';
  const testHost = TEST_DATABASE_URL.split('@')[1]?.split('/')[0] ?? '';
  
  if (ORIGINAL_DATABASE_URL && (ORIGINAL_DATABASE_URL === TEST_DATABASE_URL || (origHost && origHost === testHost))) {
    // eslint-disable-next-line no-console
    console.warn(`\n⚠️  WARNING: TEST_DATABASE_URL points to the same host/database as DATABASE_URL!`);
    // eslint-disable-next-line no-console
    console.warn(`🔒 HARD SAFETY GUARD ACTIVE: Table-wide database wiping is PERMANENTLY DISABLED.\n`);
    process.env.PREVENT_DB_WIPE = 'true';
  }

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DIRECT_URL = TEST_DATABASE_URL;
  const dbName = TEST_DATABASE_URL.split('/')[3]?.split('?')[0] ?? '';
  // eslint-disable-next-line no-console
  console.log(`\n🧪 Tests redirected to TEST_DATABASE_URL (db: "${dbName}")\n`);
} else {
  // eslint-disable-next-line no-console
  console.log(
    `\n⚠️  TEST_DATABASE_URL is NOT set — tests will run against DATABASE_URL ` +
      `(db: "${(process.env.DATABASE_URL ?? '').split('/')[3]?.split('?')[0] ?? '?'}"). ` +
      `Full database wipe is disabled; tests will only clean up scoped test records.\n`
  );
  process.env.PREVENT_DB_WIPE = 'true';
}

// ─── Safety guardrail ────────────────────────────────────────────────────────
// Refuse to run ANY test with a LIVE Paystack key. Payment tests (e.g. the
// settlement withdraw e2e) call createTransferRecipient + initiateTransfer,
// which move REAL money against an sk_live_ key. Test mode (sk_test_) is free.
const paystackKey = process.env.PAYSTACK_SECRET_KEY || '';
if (paystackKey.startsWith('sk_live_')) {
  throw new Error(
    'Refusing to run tests with a LIVE Paystack key (sk_live_…).\n' +
      'Payment tests initiate real transfers against a live key. ' +
      'Set PAYSTACK_SECRET_KEY to an sk_test_… key (or unset it) and re-run.'
  );
}

// Ensure test runner always has consistent encryption secrets
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-suite-encryption-key-32b-secret!';
}
if (!process.env.BLIND_INDEX_KEY) {
  process.env.BLIND_INDEX_KEY = 'test-suite-blind-index-key-32b-secret!';
}

