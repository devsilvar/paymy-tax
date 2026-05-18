export interface InitializePaymentParams {
  email: string;
  amount: number; // in major currency unit (e.g. Naira)
  reference: string;
  metadata?: Record<string, any>;
  callbackUrl?: string;
}

export interface InitializePaymentResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifyPaymentResult {
  status: string;
  reference: string;
  amount: number; // in major currency unit
  paidAt?: string;
  channel?: string;
  gatewayResponse?: string;
}

// ─── DVA (Dedicated Virtual Account) Types ─────────────────

export interface CreateCustomerParams {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface CreateCustomerResult {
  customerCode: string;
  customerId: number;
}

export interface CreateDVAResult {
  accountNumber: string | null;
  bankName: string | null;
  bankId: number;
}

export interface ValidateCustomerParams {
  customerCode: string;
  bvn: string;
  firstName: string;
  lastName: string;
}

export interface ValidateCustomerResult {
  validated: boolean;
}

// ─── Provider Interface ─────────────────────────────────────

export interface PaymentProvider {
  initialize(params: InitializePaymentParams): Promise<InitializePaymentResult>;
  verify(reference: string): Promise<VerifyPaymentResult>;
  createCustomer(params: CreateCustomerParams): Promise<CreateCustomerResult>;
  validateCustomer(params: ValidateCustomerParams): Promise<ValidateCustomerResult>;
  createDedicatedAccount(customerCode: string, preferredBank?: string): Promise<CreateDVAResult>;
}
