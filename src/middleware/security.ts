/**
 * Security Middleware
 * 
 * Implements various security measures:
 * - Helmet for HTTP headers
 * - CORS configuration
 * - Rate limiting
 * 
 * @author WallX Engineering Team
 */

import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from '@/config';

/**
 * Helmet configuration for secure HTTP headers
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow file downloads
});

/**
 * CORS configuration
 *
 * Production: allowlist is built from `FRONTEND_URL` (comma-separated for
 * multi-domain apps — e.g. `https://app.paymytax.ng,https://www.paymytax.ng`).
 * Dev: allow any origin so localhost ports, IP addresses, and mobile-device
 * testing all work without reconfiguration.
 */
const buildAllowedOrigins = (): string[] => {
  // `FRONTEND_URL` may be a single URL or a comma-separated list.
  const fromEnv = config.cors.frontendUrl
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Always include localhost defaults for safety (dev parity).
  const defaults = ['http://localhost:5173', 'http://localhost:3000'];

  return Array.from(new Set([...fromEnv, ...defaults]));
};

const ALLOWED_ORIGINS = buildAllowedOrigins();

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, Postman,
    // server-to-server, same-origin) — these don't carry an Origin header.
    if (!origin) return callback(null, true);

    // Dev: fully permissive.
    if (config.app.isDevelopment) {
      return callback(null, true);
    }

    // Prod: strict allowlist.
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // 24 hours
});

/**
 * Global rate limiter - applies to all routes
 */
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs, // 15 minutes
  max: config.rateLimit.maxRequests, // 100 requests per window
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later.',
    },
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
});

/**
 * Strict rate limiter for auth endpoints
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  skipSuccessfulRequests: true, // Don't count successful requests
  message: {
    error: {
      code: 'AUTH_RATE_LIMIT_EXCEEDED',
      message: 'Too many authentication attempts. Please try again in 15 minutes.',
    },
  },
});

/**
 * Rate limiter for payment endpoints
 */
export const paymentRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 payment initiations per hour
  message: {
    error: {
      code: 'PAYMENT_RATE_LIMIT_EXCEEDED',
      message: 'Too many payment attempts. Please try again later.',
    },
  },
});
