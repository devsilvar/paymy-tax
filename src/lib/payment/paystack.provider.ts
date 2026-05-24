import { config } from '@/config';
import { AppError } from '@/middleware/errorHandler';
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

  async validateCustomer(params: ValidateCustomerParams): Promise<ValidateCustomerResult> {
    await this.request('POST', `/customer/${params.customerCode}/identification`, {
      country: 'NG',
      type: 'bvn',
      value: params.bvn,
      first_name: params.firstName,
      last_name: params.lastName,
    });

    return { validated: true };
  }

  async createDedicatedAccount(customerCode: string, preferredBank = 'wema-bank'): Promise<CreateDVAResult> {
    const data = await this.request('POST', '/dedicated_account', {
      customer: customerCode,
      preferred_bank: preferredBank,
    });

    // DVA creation can be synchronous or async depending on Paystack
    const account = data?.dedicated_account || data;

    return {
      accountNumber: account?.account_number || null,
      bankName: account?.bank?.name || null,
      bankId: account?.bank?.id || 0,
    };
  }
}