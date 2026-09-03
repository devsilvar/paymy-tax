/**
 * Central Configuration Manager
 * 
 * This module loads and validates all environment variables.
 * Uses a centralized approach to prevent scattered process.env calls.
 * 
 * @author WallX Engineering Team
 */

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Validates that required environment variables are present.
 *
 * SUPABASE_* are NOT in the required set — the app uses Prisma + Postgres
 * for all DB access; Supabase is only needed if you opt into Supabase
 * Storage / Auth helpers (currently unused in this codebase).
 */
function validateConfig() {
  const required = [
    'DATABASE_URL',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your .env file against .env.example'
    );
  }
}

// Run validation on import
validateConfig();

/**
 * Application Configuration Object
 */
/**
 * Parse PORT defensively. Render/Heroku inject PORT automatically; if a user
 * also adds it in the dashboard with a bad value (empty string, whitespace,
 * non-numeric), parseInt returns NaN and app.listen throws ERR_SOCKET_BAD_PORT.
 * Fall back to 10000 (Render's default) and log loudly so it's findable.
 */
const parsePort = (raw: string | undefined): number => {
  const fallback = 10000;
  if (!raw || !raw.trim()) return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(
      `[config] Invalid PORT="${raw}" (must be integer 1-65535). Falling back to ${fallback}.`
    );
    return fallback;
  }
  return n;
};

export const config = {
  // Application
  app: {
    env: process.env.NODE_ENV || 'development',
    port: parsePort(process.env.PORT),
    apiVersion: process.env.API_VERSION || 'v1',
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
  },

  // Database
  database: {
    url: process.env.DATABASE_URL!,
  },

  // Supabase (optional — only set if you use Supabase Storage / Auth helpers)
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // JWT
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET!,
    refreshSecret: process.env.JWT_REFRESH_SECRET!,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || '',
  },

  // Payment
  payment: {
    provider: (process.env.PAYMENT_PROVIDER || 'paystack') as 'paystack' | 'wallx',
  },

  // Paystack
  //
  // `preferredBank` is the DVA-creation bank slug Paystack expects on
  // POST /dedicated_account. Test mode REQUIRES `test-bank` — `wema-bank`
  // returns a 400 with test keys. Live mode accepts `wema-bank` (default),
  // `titan-paystack`, etc. We auto-pick based on the secret-key prefix so
  // local dev with test keys just works; explicit env var overrides if you
  // ever need a different live partner bank.
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || '',
    preferredBank:
      process.env.PAYSTACK_PREFERRED_BANK ||
      ((process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_test_')
        ? 'test-bank'
        : 'wema-bank'),
    // DEV/TEST-ONLY fixture switch. When true (or when NODE_ENV=test), failed
    // Paystack name-enquiry (/bank/resolve) and subaccount-creation calls fall
    // back to a local fixture instead of surfacing the error — lets devs and
    // CI exercise settlement connect without real bank resolution.
    // NEVER set this in production; see paystack.provider.ts shouldUseBankFixture().
    mockBankResolution: process.env.PAYSTACK_MOCK_BANK_RESOLUTION === 'true',

    // Paystack's published pricing. Rules, worked examples and the source URL
    // for every number live in src/lib/paystack-fees.ts — read that first.
    // These are the defaults as published on paystack.com/pricing and
    // support.paystack.com on 2026-09-03; override via env if Paystack moves.
    fees: {
      // DVA inflow: 1% per transfer, capped at ₦300, deducted from the
      // merchant's settlement (the sender is NOT charged extra).
      dvaPct: Number(process.env.PAYSTACK_DVA_FEE_PCT ?? 1),
      dvaCap: Number(process.env.PAYSTACK_DVA_FEE_CAP ?? 300),

      // Withdrawals: banded FLAT transfer fee, not a percentage.
      transferLow: Number(process.env.PAYSTACK_TRANSFER_FEE_LOW ?? 10),
      transferLowMax: Number(process.env.PAYSTACK_TRANSFER_FEE_LOW_MAX ?? 5000),
      transferMid: Number(process.env.PAYSTACK_TRANSFER_FEE_MID ?? 25),
      transferMidMax: Number(process.env.PAYSTACK_TRANSFER_FEE_MID_MAX ?? 50000),
      transferHigh: Number(process.env.PAYSTACK_TRANSFER_FEE_HIGH ?? 50),

      // Nigeria Tax Act 2025 stamp duty, live since 18 Feb 2026: flat ₦50 on
      // every transfer of ₦10,000+ out of a Paystack balance, on top of the
      // transfer fee. Set to 0 only if the business is a registered payroll
      // merchant (the only exemption Paystack documents).
      stampDuty: Number(process.env.PAYSTACK_STAMP_DUTY ?? 50),
      stampDutyFrom: Number(process.env.PAYSTACK_STAMP_DUTY_FROM ?? 10000),

      // Who absorbs the withdrawal cost: 'merchant' deducts it from what the
      // SME asked for; 'platform' pays it on top and the SME gets the full
      // amount. Confirm with finance before flipping this.
      withdrawalFeeBearer: (process.env.WITHDRAWAL_FEE_BEARER === 'platform'
        ? 'platform'
        : 'merchant') as 'merchant' | 'platform',
    },
  },

  // DigitalOcean Spaces
  spaces: {
    endpoint: process.env.DO_SPACES_ENDPOINT || '',
    region: process.env.DO_SPACES_REGION || 'nyc3',
    bucket: process.env.DO_SPACES_BUCKET || '',
    accessKey: process.env.DO_SPACES_ACCESS_KEY || '',
    secretKey: process.env.DO_SPACES_SECRET_KEY || '',
    cdnEndpoint: process.env.DO_SPACES_CDN_ENDPOINT || '',
  },

  // Cloudinary
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },


  // Email
  email: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'PayMyTax <noreply@paymytax.ng>',
  },

  // SMS
  sms: {
    apiKey: process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || 'PayMyTax',
  },

  // Monitoring
  monitoring: {
    sentryDsn: process.env.SENTRY_DSN || '',
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  // CORS
  cors: {
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  },

  // App URLs — used in outbound links (WhatsApp messages, emails) where the
  // customer (not the SME) is the recipient. Distinct from `cors.frontendUrl`
  // because the SME-facing app and the public-PDF host might diverge in prod
  // (e.g. app.paymytax.com vs api.paymytax.com). Defaults assume single-host
  // dev where the frontend proxies /api to the backend.
  publicUrls: {
    // Base for /api/v1/public/* links (customer hits this directly, no proxy).
    apiBase:
      process.env.PUBLIC_API_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:5173',
  },

  // Tax
  tax: {
    defaultRate: parseFloat(process.env.TAX_DEFAULT_RATE || '7.5'),
    minRate: parseFloat(process.env.TAX_MIN_RATE || '0'),
    maxRate: parseFloat(process.env.TAX_MAX_RATE || '50'),
    currency: process.env.TAX_CURRENCY || 'NGN',
    taxAuthority: process.env.TAX_AUTHORITY || 'FIRS',
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10000', 10),
  },

  // PIN Security
  pin: {
    maxAttempts: Number(process.env.PIN_MAX_ATTEMPTS ?? 5),
    attemptWindowHours: Number(process.env.PIN_ATTEMPT_WINDOW_HOURS ?? 24),
  },

  // Settlement & Split Payouts
  settlement: {
    minTaxSplitPct: Number(process.env.SETTLEMENT_MIN_TAX_SPLIT_PCT ?? 7.5),
    maxTaxSplitPct: Number(process.env.SETTLEMENT_MAX_TAX_SPLIT_PCT ?? 50),
    platformCommissionPct: Number(process.env.PLATFORM_COMMISSION_PCT ?? 0),
  },

  // Scheduled Jobs (node-cron)
  // Auto-enabled in production; opt-in for dev so `tsx watch` doesn't
  // re-register the schedule on every file save.
  cron: {
    enabled:
      process.env.ENABLE_CRON === 'true' ||
      process.env.NODE_ENV === 'production',
  },
} as const;

export default config;
