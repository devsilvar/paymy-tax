// Jest setup file — loads .env before tests run so signatures match
import 'dotenv/config';

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

// Ensure PII_ENCRYPTION_KEY is populated for unit/e2e testing
if (!process.env.PII_ENCRYPTION_KEY) {
  process.env.PII_ENCRYPTION_KEY = '8GFPuob6LZNXFzzMZq5erNoVAAoQ7QiBV61CxBHrGUI=';
}
