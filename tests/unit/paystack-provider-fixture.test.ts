/**
 * Unit tests for the environment-gated Paystack bank fixture
 * (`resolveAccount` / `createSubaccount` catch-path fallback).
 *
 * Regression guard for the former `0123…` account-number prefix bypass,
 * which leaked test scaffolding into production and let unverified
 * settlement accounts "verify" and connect (see noticepay.md → NEW-4).
 *
 * The fixture may fire ONLY when:
 *   - NODE_ENV=test (CI / e2e — no real bank resolution available), or
 *   - PAYSTACK_MOCK_BANK_RESOLUTION=true (explicit local-dev opt-in).
 * In every other environment the original Paystack error propagates, and a
 * missing secret key in production surfaces a loud PAYSTACK_NOT_CONFIGURED
 * instead of a fabricated account name.
 */
describe('PaystackProvider bank fixture gating', () => {
  type EnvOverrides = Record<string, string | undefined>;

  const ENV_KEYS = ['NODE_ENV', 'PAYSTACK_MOCK_BANK_RESOLUTION', 'PAYSTACK_SECRET_KEY'];
  const FAIL = () => new Error('paystack request failed (simulated)');

  /**
   * Imports a fresh PaystackProvider with the given env overrides applied
   * (config is a module-level singleton evaluated at import time, so the
   * registry must be reset AFTER the env is in place). Env is restored right
   * after import — the provider has already captured what it needs.
   */
  async function makeProvider(env: EnvOverrides) {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.resetModules();
      const { PaystackProvider } = await import('@/lib/payment/paystack.provider');
      return new PaystackProvider();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** Force the catch path without any network I/O. */
  function failAllRequests(provider: any) {
    provider.request = jest.fn().mockRejectedValue(FAIL());
    return provider;
  }

  it('returns the fixture when NODE_ENV=test (CI/e2e behaviour preserved)', async () => {
    const provider = failAllRequests(
      await makeProvider({
        NODE_ENV: 'test',
        PAYSTACK_MOCK_BANK_RESOLUTION: undefined,
        PAYSTACK_SECRET_KEY: 'sk_test_dummy',
      }),
    );

    const result = await provider.resolveAccount('0123456789', '058');
    expect(result.accountName).toBe('TEST COMMERCIAL ENTERPRISE');
    expect(result.accountNumber).toBe('0123456789');
  });

  it('PRODUCTION: the 0123… prefix no longer bypasses verification — the real error propagates', async () => {
    const err = FAIL();
    const provider = failAllRequests(
      await makeProvider({
        NODE_ENV: 'production',
        PAYSTACK_MOCK_BANK_RESOLUTION: undefined,
        PAYSTACK_SECRET_KEY: 'sk_test_dummy',
      }),
    );
    provider.request = jest.fn().mockRejectedValue(err);

    await expect(provider.resolveAccount('0123456789', '058')).rejects.toBe(err);
  });

  it('PRODUCTION: createSubaccount also propagates the real error (no fake SUB_test_ code)', async () => {
    const err = FAIL();
    const provider = failAllRequests(
      await makeProvider({
        NODE_ENV: 'production',
        PAYSTACK_MOCK_BANK_RESOLUTION: undefined,
        PAYSTACK_SECRET_KEY: 'sk_test_dummy',
      }),
    );
    provider.request = jest.fn().mockRejectedValue(err);

    await expect(
      provider.createSubaccount({
        businessName: 'Acme Ltd',
        bankCode: '058',
        accountNumber: '0123456789',
        percentageCharge: 0,
      }),
    ).rejects.toBe(err);
  });

  it('honours PAYSTACK_MOCK_BANK_RESOLUTION=true as an explicit dev opt-in', async () => {
    const provider = failAllRequests(
      await makeProvider({
        NODE_ENV: 'production',
        PAYSTACK_MOCK_BANK_RESOLUTION: 'true',
        PAYSTACK_SECRET_KEY: 'sk_test_dummy',
      }),
    );

    const result = await provider.resolveAccount('0123456789', '058');
    expect(result.accountName).toBe('TEST COMMERCIAL ENTERPRISE');

    const sub = await provider.createSubaccount({
      businessName: 'Acme Ltd',
      bankCode: '058',
      accountNumber: '0123456789',
      percentageCharge: 0,
    });
    expect(sub.subaccountCode).toMatch(/^SUB_test_/);
  });

  it('PRODUCTION with a missing secret key → loud PAYSTACK_NOT_CONFIGURED, never a fixture', async () => {
    const provider = failAllRequests(
      await makeProvider({
        NODE_ENV: 'production',
        PAYSTACK_MOCK_BANK_RESOLUTION: undefined,
        PAYSTACK_SECRET_KEY: '',
      }),
    );

    await expect(provider.resolveAccount('0123456789', '058')).rejects.toMatchObject({
      code: 'PAYSTACK_NOT_CONFIGURED',
    });
  });
});
