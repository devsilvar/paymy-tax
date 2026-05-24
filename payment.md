# Payment Architecture — PayMyTax by WallX

> Last Updated: 2026-03-27
> Status: Planning (Phase 4)
> Reviewed by: Senior Engineer

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites — What You Need Before You Start](#prerequisites)
3. [Flow 1: Tax Payment via Paystack Checkout](#flow-1-tax-payment)
4. [Flow 2: Dedicated Virtual Accounts (DVA) — Auto Sales Capture](#flow-2-dva)
5. [WallX Integration Path](#wallx-integration)
6. [Payment Provider Abstraction Layer](#payment-provider-abstraction)
7. [Webhook Architecture](#webhook-architecture)
8. [Implementation Plan — Exact Files & Code](#implementation-plan)
9. [Edge Cases & Failure Modes](#edge-cases)
10. [Rate Limiting](#rate-limiting)
11. [Schema Support (Already in Place)](#schema-support)
12. [FIRS Settlement — Open Blocker](#firs-settlement)
13. [Build Order](#build-order)
14. [Sources](#sources)

---

## 1. Overview <a id="overview"></a>

PayMyTax needs three payment capabilities, built in order:

| # | Capability | What It Does | When to Build | Keys Needed |
|---|-----------|--------------|---------------|-------------|
| 1 | **Tax Payment** | Business pays their calculated tax via Paystack checkout | Phase 4 (NOW) | Test keys work |
| 2 | **DVA Auto-Sales** | Each business gets a bank account number; incoming transfers auto-record as sales | Phase 6 (stretch) | **Live keys required** |
| 3 | **WallX Gateway** | Replace or supplement Paystack with WallX's own payment platform | When WallX is ready | WallX API keys |

---

## 2. Prerequisites — What You Need Before You Start <a id="prerequisites"></a>

### 2.1 Paystack Account Setup

Before writing any code, you need these from your Paystack dashboard:

| Requirement | Where to Get It | Why You Need It |
|-------------|----------------|-----------------|
| **Paystack Account** | [dashboard.paystack.com](https://dashboard.paystack.com) | Your merchant account |
| **Test Secret Key** | Dashboard → Settings → API Keys & Webhooks | Server-side API calls (starts with `sk_test_`) |
| **Test Public Key** | Dashboard → Settings → API Keys & Webhooks | Frontend Paystack popup (starts with `pk_test_`) |
| **Webhook URL** | Dashboard → Settings → API Keys & Webhooks | URL Paystack sends payment events to |
| **Webhook Secret** | Same page as above | NOT the same as your secret key — this is specifically for verifying webhook signatures. **However**, Paystack actually signs webhooks with your **Secret Key**, not a separate webhook secret. So `PAYSTACK_WEBHOOK_SECRET` in your `.env` should be the same value as `PAYSTACK_SECRET_KEY`. |

### 2.2 Environment Variables

These must be in your `.env` file (already in `.env.example`):

```env
# Paystack
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxx      # Server-side API calls
PAYSTACK_PUBLIC_KEY=pk_test_xxxxxxxxxxxxx       # Sent to frontend for checkout popup
PAYSTACK_WEBHOOK_SECRET=sk_test_xxxxxxxxxxxxx   # Same as secret key — used to verify webhook signatures

# Your app's URLs
FRONTEND_URL=http://localhost:5173              # Where Paystack redirects after payment
BACKEND_URL=http://localhost:3000               # Your webhook URL base
```

### 2.3 Webhook URL for Development

Paystack needs to reach your server to send webhooks. In development, your `localhost` isn't publicly accessible. You have two options:

| Option | How | Free? |
|--------|-----|-------|
| **ngrok** | Run `ngrok http 3000`, copy the HTTPS URL, paste in Paystack dashboard | Free tier available |
| **Paystack CLI** | `paystack listen --forward-to localhost:3000/api/v1/webhooks/paystack` | Free |
| **Skip webhooks in dev** | Use the manual `/verify` endpoint instead — poll Paystack after payment | Always works |

**For production:** Your deployed URL (e.g., `https://api.paymytax.ng/api/v1/webhooks/paystack`) goes in the dashboard.

### 2.4 What You Do NOT Need Yet

- **Live keys** — test keys work for the full tax payment flow (Paystack provides test card numbers)
- **Paystack go-live approval** — only needed for live keys and DVA
- **FIRS partnership confirmation** — payment goes to your Paystack account for now, settlement destination changes later
- **Business registration verification** — only needed for DVA

---

## 3. Flow 1: Tax Payment via Paystack Checkout <a id="flow-1-tax-payment"></a>

This is the core payment flow — a business owner pays their calculated tax.

### 3.1 How It Works Step-by-Step

```
STEP 1: User clicks "Pay Tax" on a finalized tax report
    │
    │   Frontend sends: POST /api/v1/businesses/:businessId/tax/pay
    │   Body: { reportId: "uuid-of-the-report" }
    │
STEP 2: Backend validates:
    │   ✓ Report exists and belongs to this business
    │   ✓ Report is finalized (isFinalized = true)
    │   ✓ Report is NOT already paid (paymentStatus != 'completed')
    │   ✓ Report is NOT locked (isLocked = false)
    │   ✗ If any check fails → return error, stop
    │
STEP 3: Backend calls Paystack "Initialize Transaction" API
    │
    │   POST https://api.paystack.co/transaction/initialize
    │   Headers: { Authorization: "Bearer sk_test_xxx" }
    │   Body: {
    │     email: user's email,
    │     amount: taxPayable × 100  (Paystack uses kobo, not naira),
    │     reference: "PMT-{reportId}-{timestamp}",
    │     callback_url: "https://yourfrontend.com/payment/callback",
    │     metadata: {
    │       businessId: "...",
    │       reportId: "...",
    │       taxMonth: "2026-03",
    │       custom_fields: [
    │         { display_name: "Business", variable_name: "business", value: "Acme Ltd" },
    │         { display_name: "Tax Month", variable_name: "tax_month", value: "March 2026" }
    │       ]
    │     },
    │     channels: ["card", "bank_transfer", "ussd"]
    │   }
    │
STEP 4: Paystack returns authorization_url + access_code + reference
    │
    │   Backend creates a TaxPayment record:
    │   {
    │     businessId, taxReportId, amountPaid: taxPayable,
    │     paymentMethod: 'card',  (updated later from webhook)
    │     transactionReference: reference,
    │     paymentStatus: 'pending'
    │   }
    │
    │   Backend returns to frontend:
    │   { authorizationUrl: "https://checkout.paystack.com/xxx", reference: "PMT-..." }
    │
STEP 5: Frontend redirects user to Paystack checkout page
    │   OR opens Paystack popup (using public key + access_code)
    │
    │   User sees Paystack's hosted payment page.
    │   They can pay with: Card, Bank Transfer, USSD
    │
STEP 6: User completes payment on Paystack
    │
    │   TWO things happen simultaneously:
    │
    │   A) Paystack redirects user back to your callback_url with ?reference=PMT-xxx
    │      Frontend calls: GET /api/v1/businesses/:businessId/tax/payments/:id/verify
    │      (This is a fallback — webhook is the primary confirmation)
    │
    │   B) Paystack sends webhook to your server:
    │      POST /api/v1/webhooks/paystack
    │      Headers: { x-paystack-signature: "hmac-sha512-hash" }
    │      Body: { event: "charge.success", data: { reference, amount, status, ... } }
    │
STEP 7: Backend processes the webhook (PRIMARY confirmation path):
    │   1. Verify HMAC-SHA512 signature using secret key (reject if invalid)
    │   2. Return 200 OK immediately (Paystack retries on non-200, so always acknowledge first)
    │   3. Check event === "charge.success" (ignore other events for now)
    │   4. Find TaxPayment by transactionReference
    │   5. If already processed (status === 'completed') → do nothing (idempotent)
    │   6. Call Paystack Verify API to double-check: GET https://api.paystack.co/transaction/verify/:reference
    │   7. Verify amount matches (webhook amount === expected amount)
    │   8. In a single transaction:
    │      - Update TaxPayment: paymentStatus = 'completed', paymentDate = now, gatewayResponse = full response
    │      - Update MonthlyTaxReport: paymentStatus = 'completed', isLocked = true, lockedAt = now
    │      - Write audit log: 'payment.completed'
    │
    │   NOTE: Steps 3-8 run after the 200 response. If they fail, the DB stays
    │   unchanged (still 'pending'), and the manual /verify endpoint serves as
    │   the recovery path. No data corruption possible.
    │
STEP 8: User sees "Payment Successful" on the frontend
         Report now shows as "Paid" and is locked
```

### 3.2 Paystack API Calls (Exact Details)

#### Initialize Transaction

```
POST https://api.paystack.co/transaction/initialize

Headers:
  Authorization: Bearer sk_test_xxxxx
  Content-Type: application/json

Body:
{
  "email": "user@example.com",           // REQUIRED — user's email
  "amount": 150000,                       // REQUIRED — in kobo (₦1,500 = 150000)
  "reference": "PMT-abc123-1711576800",   // OPTIONAL — your unique ref (auto-generated if omitted)
  "callback_url": "https://app.paymytax.ng/payment/callback",  // OPTIONAL — override dashboard setting
  "metadata": { ... },                    // OPTIONAL — custom data attached to transaction
  "channels": ["card", "bank_transfer", "ussd"]  // OPTIONAL — limit payment methods
}

Response (success):
{
  "status": true,
  "message": "Authorization URL created",
  "data": {
    "authorization_url": "https://checkout.paystack.com/nkdks46nymizns7",
    "access_code": "nkdks46nymizns7",
    "reference": "PMT-abc123-1711576800"
  }
}
```

**CRITICAL:** `amount` is in **kobo** (smallest currency unit). ₦1,500.00 = `150000`. If you send `1500`, Paystack charges ₦15.00. Always multiply by 100.

#### Verify Transaction

```
GET https://api.paystack.co/transaction/verify/PMT-abc123-1711576800

Headers:
  Authorization: Bearer sk_test_xxxxx

Response (success):
{
  "status": true,
  "message": "Verification successful",
  "data": {
    "id": 123456789,
    "status": "success",              // THIS is the transaction status
    "reference": "PMT-abc123-1711576800",
    "amount": 150000,                 // In kobo — verify this matches your expected amount
    "currency": "NGN",
    "channel": "card",                // How they paid: card, bank_transfer, ussd
    "gateway_response": "Successful",
    "paid_at": "2026-03-27T12:00:00.000Z",
    "fees": 2250,                     // Paystack's fee in kobo
    "customer": {
      "email": "user@example.com",
      "customer_code": "CUS_xxx"
    },
    "metadata": { ... }              // Your custom metadata from initialization
  }
}
```

**CRITICAL:** The top-level `status: true` means the API call succeeded — NOT that the payment succeeded. You must check `data.status === "success"` for payment status.

### 3.3 Endpoints to Build

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/businesses/:businessId/tax/pay` | JWT | Initiate tax payment for a finalized report |
| GET | `/api/v1/businesses/:businessId/tax/payments` | JWT | List all payments for a business |
| GET | `/api/v1/businesses/:businessId/tax/payments/:id/verify` | JWT | Manually verify a payment (fallback) |
| POST | `/api/v1/webhooks/paystack` | **None** (signature verified) | Receive Paystack webhook events |

### 3.4 Test Cards (For Development)

Paystack provides test card numbers that work with test keys:

| Card Number | Expiry | CVV | Result |
|-------------|--------|-----|--------|
| 4084 0840 8408 4081 | Any future date | 408 | **Successful** payment |
| 4084 0840 8408 4081 | Any future date | 400 | **Failed** payment |
| 5060 6666 6666 6666 666 | Any future date | 123 | Verve card (successful) |

---

## 4. Flow 2: Dedicated Virtual Accounts (DVA) — Auto Sales Capture <a id="flow-2-dva"></a>

### 4.1 What This Is

Each business gets a permanent bank account number (like "7821234567 — Wema Bank"). When anyone transfers money to that account, Paystack notifies your server and you auto-record it as a sale.

This turns PayMyTax into a **passive sales tracker** — businesses don't have to manually enter every sale if their customers pay via bank transfer.

### 4.2 Requirements (MUST Have Before Building)

| Requirement | Why | How to Get It |
|-------------|-----|---------------|
| **Paystack Live Keys** | DVA does NOT work with test keys | Complete Paystack go-live process |
| **Registered Business** | Paystack only offers DVA to registered Nigerian/Ghanaian businesses | Submit business registration documents to Paystack |
| **Go-Live Approval** | Paystack must verify your business | Usually 24-48 hours after document submission |
| **Webhook URL (production)** | Must be publicly accessible HTTPS | Deploy your backend first |

### 4.3 How DVA Creation Works

```
STEP 1: Business is created on PayMyTax (or user enables DVA from settings)
    │
STEP 2: Backend creates a Paystack Customer:
    │
    │   POST https://api.paystack.co/customer
    │   Body: {
    │     email: "owner@business.com",
    │     first_name: "Chidi",
    │     last_name: "Okonkwo",
    │     phone: "+2348012345678"
    │   }
    │   Response: { data: { customer_code: "CUS_xxx" } }
    │
    │   Save customer_code to Business.paystackCustomerCode
    │
STEP 3: Backend assigns a DVA to the customer:
    │
    │   POST https://api.paystack.co/dedicated_account
    │   Body: {
    │     customer: "CUS_xxx",
    │     preferred_bank: "wema-bank"  // or "titan-paystack"
    │   }
    │
    │   This is ASYNCHRONOUS — Paystack doesn't return the account number immediately.
    │   You receive a webhook when it's ready.
    │
STEP 4: Paystack sends webhook: dedicatedaccount.assign.success
    │   Payload includes:
    │   {
    │     dedicated_account: {
    │       account_number: "7821234567",
    │       bank: { name: "Wema Bank" }
    │     }
    │   }
    │
    │   Save to Business:
    │   - virtualAccountNumber = "7821234567"
    │   - virtualAccountBank = "Wema Bank"
    │
STEP 5: Display account number to the business owner in the app
         "Your customers can pay you at: 7821234567 (Wema Bank)"
    │
STEP 6: When a customer transfers money to that account:
    │   Paystack sends `charge.success` webhook with the transfer details
    │
    │   Backend auto-creates:
    │   SalesTransaction {
    │     businessId: matched from DVA,
    │     amount: data.amount / 100,
    │     source: 'bank_transfer',
    │     status: 'confirmed',
    │     referenceId: data.reference,
    │     customerName: data.customer.first_name + " " + data.customer.last_name,
    │     transactionDate: new Date(data.paid_at),
    │     metadata: { channel: 'dva', paystackTransactionId: data.id }
    │   }
```

### 4.4 DVA Limitations to Know

- **Account creation is asynchronous** — can take seconds to minutes. Don't promise instant account numbers.
- **1,000 DVA limit** per Paystack merchant account. Email support@paystack.com if you need more.
- **1% fee** per incoming transfer, capped at ₦300. This comes from the sender's transfer, not your balance.
- **No test mode** — you cannot test DVA with test keys. You must use live keys.
- **Nigeria and Ghana only** — DVA is not available in other countries Paystack supports.
- **Some business categories** (Betting, Financial Services, General Services) require extra KYC validation of the customer before DVA assignment.

### 4.5 When to Build This

**Not now.** This is a Phase 6 stretch goal. Build it only after:
1. Tax payment flow is working in production
2. You have live keys
3. You have real businesses using the platform

---

## 5. WallX Integration Path <a id="wallx-integration"></a>

### 5.1 The Situation

WallX (your parent company) has its own payment platform. They've indicated they may want PayMyTax to use their gateway instead of (or alongside) Paystack. This hasn't been confirmed yet.

### 5.2 What This Means for Architecture

You must design the payment layer so Paystack can be **swapped out** without rewriting business logic. This is why we build a Payment Provider abstraction (see section 6).

### 5.3 Possible Future States

| Scenario | Tax Payments | DVA / Sales Capture |
|----------|-------------|---------------------|
| **Current** | Paystack checkout | Not built yet |
| **WallX replaces Paystack** | WallX gateway | WallX virtual accounts (if they offer it) |
| **WallX alongside Paystack** | Either gateway (user choice or config) | Paystack DVA (proven) |
| **WallX under the hood uses Paystack** | WallX gateway → Paystack | Same DVA flow, different API wrapper |

### 5.4 What You Need From WallX Before Building Their Provider

When WallX is ready, ask them for:
1. API documentation (initialize payment, verify payment, webhooks)
2. Test keys / sandbox environment
3. Webhook event types and payload structure
4. Whether they support virtual account creation
5. Settlement timeline (T+1? T+0?)
6. Fee structure

---

## 6. Payment Provider Abstraction Layer <a id="payment-provider-abstraction"></a>

### 6.1 Why This Matters

Without this, switching from Paystack to WallX means rewriting every file that calls Paystack. With it, you write a new provider class and change one env var.

### 6.2 Interface Design

```typescript
// src/lib/payment/types.ts

export interface InitializePaymentParams {
  email: string;
  amount: number;        // In naira (not kobo) — the provider converts internally
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, any>;
  channels?: string[];
}

export interface PaymentVerification {
  success: boolean;
  reference: string;
  amount: number;        // In naira
  channel: string;       // card, bank_transfer, ussd, etc.
  paidAt: Date | null;
  gatewayResponse: string;
  fees: number;
  rawResponse: Record<string, any>;  // Full provider response for storage
}

export interface PaymentProvider {
  /**
   * Initialize a payment — returns a URL the user should be redirected to
   */
  initializePayment(params: InitializePaymentParams): Promise<{
    authorizationUrl: string;
    accessCode: string;
    reference: string;
  }>;

  /**
   * Verify a payment by reference — call after webhook or as manual fallback
   */
  verifyPayment(reference: string): Promise<PaymentVerification>;

  /**
   * Verify that an incoming webhook is genuinely from this provider
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}
```

### 6.3 Provider Selection

```typescript
// src/lib/payment/index.ts

import { config } from '@/config';
import { PaystackProvider } from './paystack.provider';
// import { WallXProvider } from './wallx.provider';  // future

export function getPaymentProvider(): PaymentProvider {
  const provider = config.payment.provider;

  switch (provider) {
    case 'paystack':
      return new PaystackProvider();
    // case 'wallx':
    //   return new WallXProvider();
    default:
      throw new Error(`Unknown payment provider: ${provider}`);
  }
}
```

### 6.4 How the Service Layer Uses It

```typescript
// In payment.service.ts — never calls Paystack directly
const provider = getPaymentProvider();
const result = await provider.initializePayment({ ... });
```

If WallX comes along, you:
1. Create `wallx.provider.ts` implementing the same `PaymentProvider` interface
2. Change `PAYMENT_PROVIDER=wallx` in `.env`
3. Done. Zero changes to service/controller/route code.

---

## 7. Webhook Architecture <a id="webhook-architecture"></a>

### 7.1 Why Webhooks Are Critical

Paystack explicitly states: **"The only way to know when a bank transfer payment has been done is through webhooks."** You cannot rely on the frontend callback alone because:
- User may close the browser before redirecting back
- Network issues may prevent the callback redirect
- Bank transfer payments are asynchronous — the callback may happen before payment clears

### 7.2 Webhook Security Rules

| Rule | Implementation | Why |
|------|---------------|-----|
| **Verify signature FIRST** | HMAC-SHA512 of raw body using your secret key, compared to `x-paystack-signature` header | Prevents anyone from sending fake payment confirmations to your webhook URL |
| **Use raw body, not parsed JSON** | `express.json({ verify })` callback captures `req.rawBody` before parsing (already implemented in `app.ts`) | JSON.stringify(parsedBody) may produce different byte output than the original body, breaking signature verification |
| **Return 200 immediately** | Verify signature → send 200 → then process payment asynchronously in the same request via post-response processing | Paystack retries on non-200 responses, which could cause duplicate processing. Processing failures are safe — DB stays as 'pending' and manual `/verify` endpoint recovers. |
| **Idempotent processing** | Check `paymentStatus !== 'completed'` before updating | Paystack may send the same webhook multiple times (retries, network issues) |
| **No JWT auth** | Webhook route must NOT use the `authenticate` middleware | Paystack doesn't have a JWT — the HMAC signature IS the authentication |
| **Log everything** | Write every webhook event to `audit_logs` — even duplicates, even failures | Debugging payment issues months later requires a complete trail |
| **Verify amount** | Compare webhook amount with your expected amount for that reference | Prevents partial payment attacks where someone pays ₦1 and your system marks it as complete |

### 7.3 Signature Verification Code

```typescript
import crypto from 'crypto';

function verifyPaystackSignature(rawBody: string, signature: string, secretKey: string): boolean {
  const hash = crypto
    .createHmac('sha512', secretKey)
    .update(rawBody)
    .digest('hex');

  return hash === signature;
}
```

**IMPORTANT:** The `rawBody` must be the exact bytes Paystack sent — not `JSON.stringify(req.body)`. This means you need `express.raw()` middleware on the webhook route specifically, or a way to capture the raw body before JSON parsing.

### 7.4 Webhook Events You Must Handle

| Event | When | Your Action |
|-------|------|-------------|
| `charge.success` | Payment completed | Verify → update TaxPayment → lock report |
| `charge.failed` | Payment failed | Update TaxPayment status to 'failed' |
| `dedicatedaccount.assign.success` | DVA created (Phase 6) | Store account number on Business |
| `dedicatedaccount.assign.failed` | DVA creation failed (Phase 6) | Log error, notify admin |

---

## 8. Implementation Plan — Exact Files & Code <a id="implementation-plan"></a>

### 8.1 Files to Create

| File | Purpose |
|------|---------|
| `src/lib/payment/types.ts` | PaymentProvider interface + shared types |
| `src/lib/payment/paystack.provider.ts` | Paystack implementation of PaymentProvider |
| `src/lib/payment/index.ts` | Provider factory (returns active provider) |
| `src/services/payment.service.ts` | Payment business logic (initiate, verify, process webhook) |
| `src/controllers/payment.controller.ts` | HTTP handlers |
| `src/routes/payment.routes.ts` | Tax payment routes (under /businesses/:businessId/tax/) |
| `src/routes/webhook.routes.ts` | Webhook route (top-level, no JWT auth, raw body) |
| `src/validators/payment.validator.ts` | Zod schemas for payment endpoints |

### 8.2 Files to Modify

| File | Change |
|------|--------|
| `src/config/index.ts` | Add `payment.provider` config field |
| `src/routes/index.ts` | Mount payment + webhook routes |
| `src/app.ts` | Add `express.raw()` middleware for webhook route BEFORE json parser |

### 8.3 Critical Implementation Detail: Raw Body for Webhooks ✅ IMPLEMENTED

Express parses JSON bodies by default. But webhook signature verification needs the raw body.

**Solution (already in `app.ts`):** The `verify` callback on `express.json()` captures the raw body on every request:

```typescript
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf.toString();
  },
}));
```

The webhook handler accesses `(req as any).rawBody` for HMAC signature verification. This avoids route-ordering issues that `express.raw()` would cause — the raw body is always available regardless of middleware order.

---

## 9. Edge Cases & Failure Modes <a id="edge-cases"></a>

These are real scenarios that WILL happen in production. Each one must be handled.

| Scenario | What Happens | How to Handle |
|----------|-------------|---------------|
| **User pays but webhook doesn't arrive** | Payment completed on Paystack but your DB still shows 'pending' | Manual `/verify` endpoint polls Paystack. Frontend calls this after callback redirect. |
| **Webhook arrives twice** | Paystack retries, or network glitch | Idempotent check: if `paymentStatus === 'completed'`, return 200 and do nothing |
| **User pays wrong amount** | They somehow pay ₦500 instead of ₦1,500 | Compare webhook `data.amount` with TaxPayment `amountPaid`. If mismatch, mark as 'failed' and log |
| **User pays after report is un-finalized** | Report was finalized, user started payment, then you un-finalized it | Check report state in webhook handler. If not finalized, still accept payment (money already left their account) |
| **Paystack is down** | Initialize call fails | Return 503 to frontend with "Payment service temporarily unavailable" |
| **Webhook URL unreachable** | Your server was down when Paystack sent the webhook | Paystack retries webhooks. Also, the manual `/verify` endpoint serves as backup |
| **Duplicate reference** | Two payments initiated for the same report | Reference format `PMT-{reportId}-{timestamp}` prevents collisions. Also, `transactionReference` is unique in schema |
| **User abandons Paystack checkout** | They click "Pay", get redirected, then close the browser | TaxPayment stays as 'pending'. Frontend can show "Resume Payment" button. After 24h, consider it abandoned |
| **Refund requested** | Business overpaid or wants a refund | Handle in Phase 5. Paystack has a Refund API. For now, manual via Paystack dashboard |

---

## 10. Rate Limiting <a id="rate-limiting"></a>

| Operation | Limit | Why |
|-----------|-------|-----|
| Tax payment initiation | 5/hour per business | Prevent duplicate payment attempts |
| Manual payment verification | 10/hour per business | Prevent polling abuse |
| PDF generation | 20/day per business | Prevent compute abuse |
| Tax calculation | 10/hour per business | Prevent expensive DB queries |
| Webhook endpoint | No rate limit | Paystack sends what it sends — don't block it |

---

## 11. Schema Support (Already in Place) <a id="schema-support"></a>

The Prisma schema already has every field needed. Nothing new to migrate.

### Business model (DVA fields):
```prisma
paystackCustomerCode String?   // Paystack customer code (CUS_xxx)
virtualAccountNumber String?   // DVA account number (e.g., "7821234567")
virtualAccountBank   String?   // DVA bank name (e.g., "Wema Bank")
```

### TaxPayment model (payment tracking):
```prisma
amountPaid           Decimal         // Amount in naira
paymentMethod        PaymentMethod   // wallet, bank_transfer, card, paycode
transactionReference String   @unique // Your unique reference (PMT-xxx)
gatewayResponse      Json?           // Full Paystack verify response — stored for disputes
paymentStatus        PaymentStatus   // pending → processing → completed / failed / refunded
paymentDate          DateTime?       // When payment was confirmed
firsRemittanceRef    String?         // FIRS confirmation reference (future)
firsReceiptUrl       String?         // FIRS receipt download URL (future)
```

### MonthlyTaxReport model (lock after payment):
```prisma
paymentStatus PaymentStatus  // Synced with TaxPayment status
isLocked      Boolean        // Set to true after successful payment
lockedAt      DateTime?      // When it was locked
```

---

## 12. FIRS Settlement — Open Blocker <a id="firs-settlement"></a>

> **BLOCKER:** The FIRS payment path is NOT confirmed yet.

### Option A: Direct FIRS API
PayMyTax calls FIRS API directly to remit tax. Paystack is only the collection mechanism.
- **Pro:** Real-time FIRS receipts
- **Con:** Requires FIRS API partnership (not confirmed)

### Option B: Collection Account
Payments go to a Paystack subaccount owned by WallX. WallX manually remits to FIRS in batches.
- **Pro:** Works immediately, no FIRS API needed
- **Con:** Manual process, delay in FIRS receipt

### Current Design Decision
Build payment to your **default Paystack settlement account**. When FIRS confirms:
- If **Option A:** Add FIRS API call after payment confirmation
- If **Option B:** Add a `subaccount` code to the `initializePayment` call — one line change

**No business logic changes needed either way.** This is the benefit of the abstraction layer.

---

## 13. Build Order <a id="build-order"></a>

| Step | What | Depends On | Deliverable |
|------|------|-----------|-------------|
| **1** | Payment provider abstraction (types + Paystack provider + factory) | Nothing | `src/lib/payment/` directory |
| **2** | Payment service (initiate + process webhook + verify) | Step 1 | `src/services/payment.service.ts` |
| **3** | Webhook route with raw body + signature verification | Step 2 | `src/routes/webhook.routes.ts` |
| **4** | Payment controller + routes + validators | Step 2 | Controller, routes, validators |
| **5** | Mount everything + update config | Steps 1-4 | `index.ts`, `config/index.ts`, `app.ts` |
| **6** | Test with Paystack test cards | Steps 1-5 | Verified end-to-end flow |
| **7** | PDF tax statement generation | Step 5 | Phase 4 Week 9 |
| **8** | DVA auto-sales (stretch) | Live keys + deployed | Phase 6 |
| **9** | WallX provider | WallX API docs | When ready |

---

## 14. Sources <a id="sources"></a>

- [Paystack Accept Payments Guide](https://paystack.com/docs/payments/accept-payments/)
- [Paystack Transaction API (Initialize + Verify)](https://paystack.com/docs/api/transaction/)
- [Paystack Verify Payments Guide](https://paystack.com/docs/payments/verify-payments/)
- [Paystack Webhooks Guide](https://paystack.com/docs/payments/webhooks/)
- [Paystack DVA Documentation](https://paystack.com/docs/payments/dedicated-virtual-accounts/)
- [Paystack DVA API Reference](https://paystack.com/docs/api/dedicated-virtual-account/)
- [Paystack Payment Channels](https://paystack.com/docs/payments/payment-channels/)
- [Paystack DVA Support Article](https://support.paystack.com/en/articles/2124866)
