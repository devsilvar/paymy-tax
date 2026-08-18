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

// Paystack's real `GET /dedicated_account/requery` response is just a status
// message ("We are checking the status of your transfer...") — it does NOT
// return a transactions array. It triggers an async background check on
// Paystack's side; any missed transfer it finds arrives later via a normal
// charge.success webhook, exactly like a live transfer. Verified against
// https://paystack.com/docs/payments/dedicated-virtual-accounts/#requery-a-customers-dedicated-virtual-account
// A previous version of this type had a `transactions: any[]` field that
// could never be populated (Paystack never sends it) — removed rather than
// left as permanently-dead, misleading data.
export interface RequeryDVAResult {
  accountNumber: string;
  message: string;
  transactions?: any[]; // Optional array of transactions returned by Paystack requery
}

// ─── Subaccount & Settlement Types ─────────────────

export interface ResolveAccountResult {
  accountNumber: string;
  accountName: string;
  bankCode: string;
}

export interface CreateSubaccountParams {
  businessName: string;
  bankCode: string;
  accountNumber: string;
  percentageCharge: number; // Platform commission %
}

export interface CreateSubaccountResult {
  subaccountCode: string;
}

export interface SplitDedicatedAccountResult {
  accountNumber: string | null;
  bankName: string | null;
}

// Paystack moved from `type:'bvn'` to `type:'bank_account'` validation —
// the new shape requires both the customer's BVN *and* a bank account on
// their name (account_number + bank_code) so Paystack can cross-check.
// Names are sourced from `business.ownerName`; bank/account come from a
// new BVN form on the frontend.
export interface ValidateCustomerParams {
  customerCode: string;
  bvn: string;
  bankCode: string;
  accountNumber: string;
  firstName: string;
  lastName: string;
}

export interface ValidateCustomerResult {
  validated: boolean;
}

// ─── Bank list (for BVN validation dropdown) ─────────────────
//
// Returned by Paystack `GET /bank?country=nigeria`. `slug` is the
// `preferred_bank` identifier used on `/dedicated_account`; `code` is the
// NIBSS clearing code used as `bank_code` on customer identification.
export interface BankRecord {
  name: string;
  slug: string;
  code: string;
  longCode?: string | null;
  country: string;
  currency: string;
  type?: string | null;
  active: boolean;
}

// ─── Provider Interface ─────────────────────────────────────

export interface PaymentProvider {
  initialize(params: InitializePaymentParams): Promise<InitializePaymentResult>;
  verify(reference: string): Promise<VerifyPaymentResult>;
  createCustomer(params: CreateCustomerParams): Promise<CreateCustomerResult>;
  validateCustomer(params: ValidateCustomerParams): Promise<ValidateCustomerResult>;
  // `preferredBank` is required (no default) — resolution lives in
  // `config.paystack.preferredBank`. See PaystackProvider.createDedicatedAccount.
  createDedicatedAccount(
    customerCode: string,
    preferredBank: string,
    subaccount?: string
  ): Promise<CreateDVAResult>;
  requeryDVA(accountNumber: string, providerSlug: string): Promise<RequeryDVAResult>;
  listBanks(country?: string): Promise<BankRecord[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolveAccountResult>;
  createSubaccount(params: CreateSubaccountParams): Promise<CreateSubaccountResult>;
  // Attach (or update) a subaccount split on an EXISTING dedicated virtual
  // account. New DVAs get the subaccount at creation time via
  // createDedicatedAccount's `subaccount` arg; this is the retrofit path for
  // accounts that were created before the SME connected their payout bank.
  splitDedicatedAccount(
    customerCode: string,
    subaccount: string
  ): Promise<SplitDedicatedAccountResult>;
}
