import { config } from '@/config';
import { AppError } from '@/middleware/errorHandler';
import logger from '@/lib/logger';
import {
  PaymentProvider,
  InitializePaymentParams,
  InitializePaymentResult,
  VerifyPaymentResult,
  CreateCustomerParams,
  CreateCustomerResult,
  CreateDVAResult,
  ValidateCustomerParams,
  ValidateCustomerResult,
  BankRecord,
  RequeryDVAResult,
  ResolveAccountResult,
  CreateSubaccountParams,
  CreateSubaccountResult,
  SplitDedicatedAccountResult,
  UpdateSubaccountParams,
  CreateTransferRecipientParams,
  CreateTransferRecipientResult,
  InitiateTransferParams,
  InitiateTransferResult,
  VerifyTransferResult,
} from './types';

const BASE_URL = 'https://api.paystack.co';

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
  meta?: { nextStep?: string };
  code?: string;
  type?: string;
}

export class PaystackProvider implements PaymentProvider {
  private secretKey: string;

  constructor() {
    this.secretKey = config.paystack.secretKey;
  }

  /**
   * Whether failed name-enquiry / subaccount calls may fall back to a local
   * test fixture. Strictly environment-gated:
   *   - NODE_ENV=test  → CI/e2e never needs real bank resolution.
   *   - PAYSTACK_MOCK_BANK_RESOLUTION=true → explicit local-dev opt-in.
   * There is deliberately NO input-shape gate (the old `0123…` prefix bypass
   * leaked into production and let unverified settlement accounts connect).
   * Production without this gate either surfaces the real Paystack error or —
   * if the deployment is missing its secret key — a loud PAYSTACK_NOT_CONFIGURED.
   */
  private shouldUseBankFixture(): boolean {
    return config.app.env === 'test' || config.paystack.mockBankResolution;
  }

  /**
   * Fixture result for resolveAccount — only ever returned when
   * shouldUseBankFixture() is true. Logs a warning so accidental fixture use
   * in a non-test environment is visible in logs.
   */
  private resolveAccountFixture(accountNumber: string, bankCode: string): ResolveAccountResult {
    logger.warn('Paystack bank fixture used — no real name enquiry performed', {
      op: 'resolveAccount',
      env: config.app.env,
      accountLast4: accountNumber.slice(-4),
    });
    return {
      accountNumber,
      accountName: 'TEST COMMERCIAL ENTERPRISE',
      bankCode,
    };
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const responseData = await response.json() as PaystackResponse<T>;

    if (!responseData.status) {
      const message = responseData.message || 'Paystack request failed';
      const meta = responseData.meta?.nextStep ? ` ${responseData.meta.nextStep}` : '';
      throw new AppError(
        response.status >= 400 && response.status < 500 ? 400 : 502,
        `${message}${meta}`,
        'PAYSTACK_ERROR',
        { paystackCode: responseData.code, type: responseData.type },
      );
    }

    return responseData.data;
  }

  async initialize(params: InitializePaymentParams): Promise<InitializePaymentResult> {
    const data = await this.request('POST', '/transaction/initialize', {
      email: params.email,
      amount: Math.round(params.amount * 100),
      reference: params.reference,
      metadata: params.metadata,
      callback_url: params.callbackUrl,
    });

    return {
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      reference: data.reference,
    };
  }

  async verify(reference: string): Promise<VerifyPaymentResult> {
    const data = await this.request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

    return {
      status: data.status,
      reference: data.reference,
      amount: data.amount / 100,
      paidAt: data.paid_at,
      channel: data.channel,
      gatewayResponse: data.gateway_response,
    };
  }

  // ─── DVA Methods ────────────────────────────────────────────────────

  async createCustomer(params: CreateCustomerParams): Promise<CreateCustomerResult> {
    const data = await this.request('POST', '/customer', {
      email: params.email,
      first_name: params.firstName,
      last_name: params.lastName,
      phone: params.phone,
    });

    return {
      customerCode: data.customer_code,
      customerId: data.id,
    };
  }

  /**
   * Validate a Paystack customer's identity.
   *
   * Paystack deprecated the BVN-only shape (`type: 'bvn'`) in favour of the
   * bank-account-verification shape (`type: 'bank_account'`), which requires
   * a bank account number registered against the same BVN. The new shape
   * cross-references NIBSS records and is the only shape that lifts the
   * fintech "validation_required" gate on DVA creation.
   *
   * Reference: https://paystack.com/docs/identity-verification/validate-customer/
   *
   * Note `country: 'NG'` (two-letter ISO) — the validation endpoint expects
   * the ISO code, not the slug used by `GET /bank?country=nigeria`.
   */
  async validateCustomer(params: ValidateCustomerParams): Promise<ValidateCustomerResult> {
    await this.request('POST', `/customer/${params.customerCode}/identification`, {
      country: 'NG',
      type: 'bank_account',
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      bvn: params.bvn,
      first_name: params.firstName,
      last_name: params.lastName,
    });

    return { validated: true };
  }

  /**
   * Fetch the list of banks Paystack supports for the given country.
   *
   * Used by `bank.service.ts` to populate the bank dropdowns (BVN validation +
   * settlement). Heavy to call on every request — 24h cached in the `banks`
   * table. The full Nigerian list (including microfinance banks) is several
   * HUNDRED entries, so a single `perPage=100` page truncates it badly. We use
   * Paystack's cursor pagination (`use_cursor=true` → `meta.next`) and follow
   * the cursor until exhausted, accumulating every page. A hard page cap stops
   * a misbehaving cursor from looping forever.
   */
  async listBanks(country = 'nigeria'): Promise<BankRecord[]> {
    const out: BankRecord[] = [];
    const seen = new Set<string>();
    let next: string | null = null;
    const MAX_PAGES = 20; // 20 × 100 = 2000 banks, far above the real total

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        country,
        use_cursor: 'true',
        perPage: '100',
      });
      if (next) params.set('next', next);

      const { data, meta } = await this.requestWithMeta<Array<Record<string, any>>>(
        'GET',
        `/bank?${params.toString()}`,
      );

      if (!Array.isArray(data)) {
        throw new AppError(502, 'Paystack returned unexpected bank list shape', 'PAYSTACK_ERROR');
      }

      for (const b of data) {
        // De-dupe by code — cursor overlaps can repeat the boundary row.
        if (seen.has(b.code)) continue;
        seen.add(b.code);
        out.push({
          name: b.name,
          slug: b.slug,
          code: b.code,
          longCode: b.longcode ?? null,
          // Canonicalise to lowercase. Paystack returns "Nigeria" for most
          // rows but omits `country` on a few (e.g. Sparkle), which then fell
          // back to the lowercase `country` param. That casing split made the
          // case-sensitive cache query match only the lowercase rows. Always
          // store lowercase so reads are consistent.
          country: (b.country ?? country).toLowerCase(),
          currency: b.currency ?? 'NGN',
          type: b.type ?? null,
          active: b.active !== false,
        });
      }

      next = meta?.next ?? null;
      if (!next) break;
    }

    return out;
  }

  /**
   * Like `request()` but returns Paystack's `meta` block alongside `data` —
   * needed for cursor pagination (`meta.next`), which the standard helper
   * discards.
   */
  private async requestWithMeta<T = any>(
    method: string,
    path: string,
    body?: Record<string, any>,
  ): Promise<{ data: T; meta?: { next?: string | null; previous?: string | null; perPage?: number } }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const responseData = (await response.json()) as PaystackResponse<T> & {
      meta?: { next?: string | null; previous?: string | null; perPage?: number };
    };

    if (!responseData.status) {
      const message = responseData.message || 'Paystack request failed';
      throw new AppError(
        response.status >= 400 && response.status < 500 ? 400 : 502,
        message,
        'PAYSTACK_ERROR',
        { paystackCode: responseData.code, type: responseData.type },
      );
    }

    return { data: responseData.data, meta: responseData.meta };
  }

  /**
   * Create a Dedicated Virtual Account for a Paystack customer.
   *
   * `preferredBank` is REQUIRED and intentionally not defaulted at this layer.
   * The correct slug is mode-dependent (`test-bank` for sk_test_*, `wema-bank`
   * for live, `titan-paystack` for some live partners) and the resolution lives
   * in `config.paystack.preferredBank`. Defaulting here would silently send
   * `wema-bank` from any forgetful caller — Paystack rejects that with a 400
   * in test mode and the failure mode is "DVA never sets up locally" which is
   * exactly what bit us before. Pass `config.paystack.preferredBank`.
   */
  async createDedicatedAccount(
    customerCode: string,
    preferredBank: string,
    subaccount?: string,
  ): Promise<CreateDVAResult> {
    if (!preferredBank) {
      throw new AppError(
        500,
        'preferredBank is required for createDedicatedAccount — pass config.paystack.preferredBank',
        'PAYSTACK_CONFIG_ERROR',
      );
    }

    const data = await this.request('POST', '/dedicated_account', {
      customer: customerCode,
      preferred_bank: preferredBank,
      ...(subaccount ? { subaccount } : {}),
    });

    // DVA creation can be synchronous or async depending on Paystack
    const account = data?.dedicated_account || data;

    return {
      accountNumber: account?.account_number || null,
      bankName: account?.bank?.name || null,
      bankId: account?.bank?.id || 0,
    };
  }

  /**
   * Requery a Dedicated Virtual Account to refresh transactions.
   * Useful when webhooks are missed or delayed.
   */
  async requeryDVA(accountNumber: string, providerSlug: string): Promise<RequeryDVAResult> {
    const path = `/dedicated_account/requery?account_number=${encodeURIComponent(accountNumber)}&provider_slug=${encodeURIComponent(providerSlug)}`;
    const data = await this.request<any>('GET', path);

    return {
      accountNumber: data?.account_number || accountNumber,
      message: 'DVA requery initiated successfully',
      transactions: data?.transactions || [],
    };
  }

  /**
   * Resolve account - name enquiry to verify bank account ownership
   */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolveAccountResult> {
    try {
      const data = await this.request(
        'GET',
        `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      );

      return {
        accountNumber: data.account_number,
        accountName: data.account_name,
        bankCode: data.bank_code || bankCode,
      };
    } catch (err) {
      if (this.shouldUseBankFixture()) {
        return this.resolveAccountFixture(accountNumber, bankCode);
      }
      // Production (or dev without the opt-in flag): never fake a resolved
      // name. A missing secret key means this deployment cannot verify bank
      // accounts at all — fail loudly instead of pretending success.
      if (!this.secretKey) {
        throw new AppError(
          503,
          'Paystack is not configured on this deployment (missing PAYSTACK_SECRET_KEY). Bank account verification is unavailable.',
          'PAYSTACK_NOT_CONFIGURED',
        );
      }
      throw err;
    }
  }

  /**
   * Create subaccount for split-settlement
   */
  async createSubaccount(params: CreateSubaccountParams): Promise<CreateSubaccountResult> {
    try {
      const data = await this.request('POST', '/subaccount', {
        business_name: params.businessName,
        bank_code: params.bankCode,
        account_number: params.accountNumber,
        percentage_charge: params.percentageCharge,
      });

      return {
        subaccountCode: data.subaccount_code,
      };
    } catch (err) {
      if (this.shouldUseBankFixture()) {
        logger.warn('Paystack bank fixture used — no real subaccount created', {
          op: 'createSubaccount',
          env: config.app.env,
          accountLast4: params.accountNumber.slice(-4),
        });
        return {
          subaccountCode: `SUB_test_${Math.random().toString(36).slice(2, 8)}`,
        };
      }
      // Same contract as resolveAccount: production never gets a fake
      // subaccount code — a settlement destination must be provisioned by the
      // real gateway or the connect attempt must fail visibly.
      if (!this.secretKey) {
        throw new AppError(
          503,
          'Paystack is not configured on this deployment (missing PAYSTACK_SECRET_KEY). Settlement account connection is unavailable.',
          'PAYSTACK_NOT_CONFIGURED',
        );
      }
      throw err;
    }
  }

  /**
   * Attach (or update) a subaccount split on an existing dedicated virtual
   * account — the retrofit path for DVAs created before the SME connected a
   * payout bank. Idempotent on Paystack's side: re-posting the same subaccount
   * just re-sets it, so calling this on an already-split DVA is safe.
   *
   * Endpoint: POST /dedicated_account/split with { customer, subaccount }.
   * `customer` is the Paystack customer code (CUS_xxxx) that owns the DVA.
   * Reference: https://paystack.com/docs/api/dedicated-virtual-account/
   */
  async splitDedicatedAccount(
    customerCode: string,
    subaccount: string,
  ): Promise<SplitDedicatedAccountResult> {
    const data = await this.request('POST', '/dedicated_account/split', {
      customer: customerCode,
      subaccount,
    });

    return {
      accountNumber: data?.account_number ?? null,
      bankName: data?.bank?.name ?? null,
    };
  }

  /**
   * Update subaccount settings (e.g. adjust split percentage)
   */
  async updateSubaccount(
    subaccountCode: string,
    params: UpdateSubaccountParams
  ): Promise<{ subaccountCode: string }> {
    try {
      const data = await this.request('PUT', `/subaccount/${subaccountCode}`, {
        business_name: params.businessName,
        bank_code: params.bankCode,
        account_number: params.accountNumber,
        percentage_charge: params.percentageCharge,
      });

      return {
        subaccountCode: data?.subaccount_code ?? subaccountCode,
      };
    } catch (err) {
      if (this.shouldUseBankFixture() || subaccountCode.startsWith('SUB_test_')) {
        logger.warn('Paystack bank fixture used — no real subaccount updated', {
          op: 'updateSubaccount',
          env: config.app.env,
          subaccountCode,
        });
        return {
          subaccountCode,
        };
      }
      throw err;
    }
  }

  /**
   * Create transfer recipient for payout withdrawals
   */
  async createTransferRecipient(
    params: CreateTransferRecipientParams
  ): Promise<CreateTransferRecipientResult> {
    const data = await this.request('POST', '/transferrecipient', {
      type: 'nuban',
      name: params.name,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: params.currency || 'NGN',
      description: params.description,
    });

    return {
      recipientCode: data.recipient_code,
    };
  }

  /**
   * Initiate instant balance payout transfer
   */
  async initiateTransfer(
    params: InitiateTransferParams
  ): Promise<InitiateTransferResult> {
    const data = await this.request('POST', '/transfer', {
      source: 'balance',
      amount: Math.round(params.amount * 100), // convert Naira to Kobo
      recipient: params.recipient,
      reason: params.reason,
      reference: params.reference,
    });

    return {
      transferCode: data.transfer_code,
      status: data.status || 'success',
      reference: params.reference,
      amount: params.amount,
    };
  }

  /**
   * Verify status of a transfer by reference
   */
  async verifyTransfer(reference: string): Promise<VerifyTransferResult> {
    const data = await this.request('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
    return {
      reference: data.reference,
      status: data.status,
      transferCode: data.transfer_code,
      amount: data.amount ? data.amount / 100 : undefined,
      gatewayResponse: data.gateway_response,
    };
  }
}