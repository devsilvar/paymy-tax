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
// `logger` is used in the CORS callback below (line ~72) to log blocked
// origins in production. Without this import, `tsc` errors and any blocked
// origin in prod would also be a runtime ReferenceError crash mid-request.
import logger from '@/lib/logger';

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

    // Log the blocked origin but don't crash - return a JSON response instead
    logger.warn(`CORS blocked origin: ${origin}. Add to FRONTEND_URL env var.`);
    return callback(null, false);
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
  max: 5000, // 50 requests per window (increased for testing)
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

/**
 * Strict rate limiter for password reset endpoints
 * 
 * More restrictive than general auth limiter to prevent:
 * - Email bombing attacks
 * - User enumeration attempts
 * - Resource exhaustion via email sending
 * 
 * Enterprise best practice: 3-5 attempts per hour per IP
 * Development: Higher limit for testing (10 per 15 minutes)
 */
export const passwordResetRateLimiter = rateLimit({
  windowMs: config.app.isDevelopment ? 15 * 60 * 1000 : 60 * 60 * 1000, // 15 min (dev) / 1 hour (prod)
  max: config.app.isDevelopment ? 10 : 3, // 10 attempts (dev) / 3 attempts (prod)
  skipSuccessfulRequests: false, // Count all requests to prevent enumeration
  message: {
    error: {
      code: 'PASSWORD_RESET_RATE_LIMIT_EXCEEDED',
      message: 'Too many password reset attempts. Please try again in 1 hour.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});
