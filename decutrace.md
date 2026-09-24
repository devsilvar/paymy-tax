# PayMyTax WebApp — Race Condition Audit & Deduction Report (`decutrace.md`)

## Executive Summary

This document presents a comprehensive architectural deduction of race conditions and API fan-out vulnerabilities identified across the PayMyTax frontend web application.

In single-page applications handling financial, tax, and ledger workflows, race conditions manifest in two critical failure modes:

1. **Network Fan-Out & Uncoordinated APIs**: A single page view triggers 3 to 6 separate HTTP endpoints in parallel rather than consuming a unified, atomic composite endpoint. Different components load and resolve asynchronously, producing screen flickering, partial renders, and visual disagreements between cards and data tables.
2. **"Fast-After-Slow" Response Overwrite (Out-of-Order Execution)**: When a user quickly switches filters, flips months, paginates, types into search bars, or switches active businesses, multiple asynchronous HTTP requests are in flight simultaneously. When an earlier, slower request finishes *after* a newer, faster request, the stale response overwrites the active view with outdated or mismatched data.
3. **Cross-Business State Leakage**: When switching between businesses via the sidebar, global stores that do not track the initiating `businessId` can accept responses from Business A and display them in the context of Business B.

---

## Detailed Page-by-Page Audit & Deductions

### 1. `Account.tsx` (Virtual Bank / Wallet & Settlements) — 🚨 Severity: CRITICAL (Highest Risk)

* **Current Architecture**:
  On initial mount and every manual refresh, `useAccountData.ts` fires **6 separate uncoordinated API calls**:
  1. `GET /businesses/:id/dva/virtual-account` (DVA status and assigned account number)
  2. `GET /businesses/:id/dva/transactions?limit=50` (DVA inflow transaction list)
  3. `GET /businesses/:id/settlements/preview` (Live wallet balance & bank account preview)
  4. `GET /businesses/:id/settlements/payouts` (Withdrawal and payout history)
  5. `GET /banks` (Static Nigerian bank directory)
  6. `GET /businesses` (Active business profile refresh)

* **The Race Condition & Financial Inconsistency**:
  - **Client-Side Balance Calculation Race**: In `useAccountData.ts`, `totalBalance` and `receivedThisMonth` are computed client-side by iterating over the 50 transactions fetched from `/dva/transactions`. Concurrently, `/settlements/preview` queries the authoritative backend ledger balance.
  - **Visual Flicker & Value Mismatch**: If `/dva/transactions` resolves first, the UI renders the client-calculated sum. When `/settlements/preview` arrives moments later, the balance jumps to the server ledger balance.
  - **Data Inaccuracy on Scale**: If a business has more than 50 transactions, the client-calculated sum is fundamentally truncated and incorrect, causing a stark disagreement between the KPI balance card and the actual ledger.
  - **Independent Failures**: If call #3 fails but call #2 succeeds (via `Promise.allSettled`), the user sees an outdated or zero balance alongside a populated transaction feed.

* **Architectural Fix**:
  Create a single composite endpoint:
  ```
  GET /api/v1/businesses/:id/account/dashboard
  ```
  Returning `{ dva, balance, bankAccount, recentInflows, recentPayouts, limits }` in **one atomic database roundtrip**.

---

### 2. `Sales.tsx` (Sales Register Page) — ⚠️ Severity: HIGH

* **Current Architecture**:
  On mount and upon every filter, pagination, or month change, `Sales.tsx` fires **3 separate parallel calls**:
  1. `api.get(basePath)` (Paginated transactions table)
  2. `api.get('${basePath}/summary')` (Monthly aggregate metrics: total sales, taxable sales, VAT)
  3. `api.get('${basePath}/daily')` (Daily breakdown strip)

* **The Race Condition**:
  - **No In-Flight Cancellation**: None of `fetchSales()`, `fetchSummary()`, or `fetchDaily()` utilize an `AbortController` or sequence token.
  - **Rapid Month-Flipping Race**: When a user rapidly clicks previous months (e.g., April → March → February), three summary requests are dispatched in rapid succession. If the query for March takes 350ms to aggregate on PostgreSQL while February's simpler data takes only 90ms, the March response arrives last and overwrites the state. The user sees "February" in the date header, but the numbers displayed belong to "March".
  - **Pagination Race**: Clicking Page 2 and then Page 3 quickly can result in Page 2's payload arriving after Page 3, displaying Page 2 records while the pagination indicator shows "Page 3".
  - **Wasted Network Bandwidth**: Even when a user stays exclusively on the "Daily" view tab, `fetchSales()` and `fetchSummary()` are still executed.

* **Architectural Fix**:
  - Pass browser-native `AbortController` signals to cancel obsolete in-flight requests on dependency change.
  - Optionally provide a composite summary endpoint or fetch strictly the data needed for the active tab.

---

### 3. `Expenses.tsx` (Expenses Register Page) — ⚠️ Severity: HIGH

* **Current Architecture**:
  Directly mirrors `Sales.tsx`, executing **3 separate parallel calls**:
  1. `api.get(basePath)` (Paginated expense records)
  2. `api.get('${basePath}/summary')` (Monthly category breakdown & deductible totals)
  3. `api.get('${basePath}/daily')` (Daily expense register)

* **The Race Condition**:
  - Rapidly switching category filters (e.g., "All" → "Logistics" → "Utilities") or shifting calendar periods triggers overlapping network requests.
  - A slower response from a wide date/category query can overwrite the results of a subsequent narrower search, showing records that do not match the selected category chip.

* **Architectural Fix**:
  - Integrate request abort signals on parameter change.
  - Scope expense state updates strictly to the latest request identifier.

---

### 4. `Dashboard.tsx` (Main Business Dashboard) — ⚠️ Severity: HIGH

* **Current Architecture**:
  The dashboard loads data from multiple domain slices:
  - 4 calls via `fetchDashboardBundle`:
    1. `GET /tax/dashboard?months=6`
    2. `GET /sales?limit=5`
    3. `GET /expenses?limit=5`
    4. `GET /tax/reports?limit=3`
  - 2 calls via `useCreditStore`:
    5. `GET /credits/summary`
    6. `GET /credits?limit=5`

* **The Race Condition (Cross-Business Leakage)**:
  - While `fetchDashboardBundle` implements a local `cancelled` flag to prevent old business data from overwriting new business data during rapid business switching, **`useCreditStore.fetchCreditSummary(bid)` and `fetchCredits(bid)` lack cancellation protection**.
  - When switching from *Business A* to *Business B*, if Business A's credit request experiences higher latency than Business B's, Business A's debtors and outstanding balance will overwrite Business B's store state.
  - Result: The user is viewing *Business B*, but the debtors widget displays the customers and debts of *Business A*.

* **Architectural Fix**:
  - Add request cancellation and active `businessId` validation inside `credit.store.ts`.
  - Include credit/debtor summary metrics directly inside the backend dashboard summary endpoint.

---

### 5. `Debtors.tsx` & `useCreditStore.ts` — ⚠️ Severity: MEDIUM-HIGH

* **Current Architecture**:
  - On user search input and filter changes, both `fetchCredits` (list) and `fetchSummary` (KPIs) fire in parallel.
  - State updates are processed directly into the Zustand store without sequence validation.

* **The Race Condition**:
  - **Search Debounce Race**: If a user types "Emeka", pauses briefly, and then deletes back to "Em", two network requests are fired. If the database takes longer to scan the prefix "Em" than the exact match "Emeka", the "Emeka" result can resolve after the "Em" request completes, leaving the table filtered for "Emeka" while the search field displays "Em".
  - **Filter Flapping**: Switching rapidly between "All", "Pending", and "Overdue" causes out-of-order state updates.

* **Architectural Fix**:
  - Attach an `AbortController` to search and filter requests, aborting the active query whenever the search string or filter changes.
  - Discard responses in `credit.store.ts` if the request payload does not match the current search term and business ID.

---

### 6. `TaxReports.tsx` — ⚠️ Severity: MEDIUM

* **Current Architecture**:
  - `TaxReportsList` triggers `fetchReports` whenever `[activeBusiness, page, filterStatus, filterYear]` changes.

* **The Race Condition**:
  - Rapidly clicking status pills ("All" → "Pending" → "Finalized") or switching years triggers multiple calls without cancelling previous requests.
  - A slower response from a prior filter can overwrite the current filter selection, resulting in a UI state where the badge says "Finalized" but the list displays "All" or "Pending" reports.

* **Architectural Fix**:
  - Implement request cancellation via cleanup functions in React `useEffect`.

---

## What Is Already Protected (Well-Architected Areas)

Not all pages suffer from race conditions. The following modules already implement robust safeguards:

1. **`Invoices.tsx` & `invoice.store.ts`**:
   - Implements a cache key pattern (`listCacheKey`) and stale-while-revalidate mechanism.
   - Ignores responses if parameters no longer match.
2. **`business.store.ts`**:
   - Uses an in-flight deduplication flag (`inflight`) to prevent duplicate concurrent business fetches.
3. **Backend Critical Transactions**:
   - `merchant-payout.service.ts` uses PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) to prevent race conditions during balance withdrawals.
   - `credit.service.ts` uses row locks during payment recording to prevent double-crediting.
   - Invoice payment relies on database unique constraints on `linkedSaleId`.

---

## Summary Matrix of Frontend Race Conditions

| Page / Component | Parallel Calls Fired | Root Mechanism | Manifested Symptom | Severity |
| :--- | :---: | :--- | :--- | :---: |
| **`Account.tsx`** | **6 calls** | Scattered endpoints + client-side balance math | Balance jumps/flickers; wrong sum if >50 txns | 🚨 **CRITICAL** |
| **`Sales.tsx`** | **3 calls** | Uncoordinated calls without `AbortController` | Rapid month/page clicks show stale month data | ⚠️ **HIGH** |
| **`Expenses.tsx`** | **3 calls** | Identical structure to `Sales.tsx` | Out-of-order response overwrites filtered categories | ⚠️ **HIGH** |
| **`Dashboard.tsx`** | **6 calls** | `useCreditStore` lacks business switch cancel | Business A debtors bleed into Business B view | ⚠️ **HIGH** |
| **`Debtors.tsx`** | **2 calls** | Search debounce has no in-flight abort | Fast typing displays stale search results | ⚠️ **MEDIUM-HIGH** |
| **`TaxReports.tsx`** | **1 call (uncancelled)** | Rapid filter toggling without abort | Selected tab says "Finalized" but shows "All" | ⚠️ **MEDIUM** |

---

## Recommended Senior Engineering Remediation Plan

To permanently eradicate race conditions across the frontend, implement the following three-tier strategy:

### Tier 1: Backend Composite Endpoints (Eliminate Fan-Out)
- **Consolidate `Account.tsx`**:
  Create `GET /api/v1/businesses/:id/account/dashboard` returning:
  ```json
  {
    "success": true,
    "data": {
      "virtualAccount": { ... },
      "ledgerBalance": 250000.00,
      "pendingSettlement": 0.00,
      "receivedThisMonth": 120000.00,
      "recentInflows": [ ... ],
      "recentPayouts": [ ... ],
      "bankAccount": { ... }
    }
  }
  ```
  *Benefit*: Replaces 4 HTTP roundtrips with 1 atomic database query. Completely removes client-side arithmetic from the frontend.

- **Consolidate `Sales.tsx` and `Expenses.tsx`**:
  Provide an optional query flag (e.g. `?includeSummary=true&includeDaily=true`) so the table, summary cards, and daily register arrive in a single coordinated response.

### Tier 2: Browser-Native Request Cancellation (`AbortController`)
In all React components where parameter changes trigger API calls, wire an `AbortController`:
```typescript
useEffect(() => {
  if (!activeBusiness?.id) return;
  const controller = new AbortController();

  fetchData({ signal: controller.signal });

  return () => {
    controller.abort(); // Automatically cancels obsolete in-flight requests
  };
}, [activeBusiness?.id, page, filterStatus, selectedMonth]);
```

### Tier 3: Business Scoping & Request Identification in Zustand Stores
In all global Zustand stores (`credit.store.ts`, `invoice.store.ts`, `ledger.store.ts`):
1. Immediately clear or invalidate active state when `businessId` changes.
2. Tag outgoing requests with a request counter or the target `businessId`:
```typescript
// Inside store action
const currentRequestId = ++lastRequestId;
const res = await api.get(`/credits?businessId=${bid}`);
if (currentRequestId !== lastRequestId || get().activeBusinessId !== bid) {
  return; // Discard stale response
}
```
