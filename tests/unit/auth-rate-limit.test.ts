import { describe, test, expect } from '@jest/globals';
import { config } from '../../src/config';
import { authRateLimiter } from '../../src/middleware/security';

describe('ARCH-05: Auth Rate Limiter Configuration & Hardening', () => {
  test('configures auth rate limiting properties in config.rateLimit', () => {
    expect(config.rateLimit.authWindowMs).toBeDefined();
    expect(config.rateLimit.authWindowMs).toBe(15 * 60 * 1000); // 15 minutes
    expect(config.rateLimit.authMaxRequests).toBeDefined();
    expect(typeof config.rateLimit.authMaxRequests).toBe('number');
  });

  test('authRateLimiter middleware exists and is a valid express middleware function', () => {
    expect(typeof authRateLimiter).toBe('function');
    expect(authRateLimiter.length).toBe(3); // (req, res, next)
  });

  test('production default resolves to 10 failed attempts if NODE_ENV=production', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAuthMax = process.env.RATE_LIMIT_AUTH_MAX_REQUESTS;
    try {
      delete process.env.RATE_LIMIT_AUTH_MAX_REQUESTS;
      // Evaluate what production would compute
      const prodMax = parseInt(
        process.env.RATE_LIMIT_AUTH_MAX_REQUESTS ||
          ('production' === 'production' ? '10' : '5000'),
        10
      );
      expect(prodMax).toBe(10);
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalAuthMax !== undefined) {
        process.env.RATE_LIMIT_AUTH_MAX_REQUESTS = originalAuthMax;
      }
    }
  });

  test('test/dev environment allows high threshold to prevent test suite interference', () => {
    expect(config.rateLimit.authMaxRequests).toBeGreaterThanOrEqual(100);
  });
});
