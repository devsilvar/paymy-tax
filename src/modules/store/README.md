# Storefront Domain Module (`src/modules/store`)

## Architectural Overview & Integration Blueprint

This module defines the architectural contracts, data models, and integration specifications for **PayMyTax by WallX Self-Serve Storefronts**.

As documented in `codebaserefactor.md` (v1.3) and `PHASED_EXECUTION_PLAN.md` (Phase 4), this specification governs how storefront commerce safely connects to **Central User Wallets**, **Business Sales Ledgers**, and **FIRS 7.5% Tax Compliance** with zero double-booking or circular dependencies.

---

## 1. Core Architectural Invariants

### Invariant 1: Single Atomic Database Transaction
When a customer pays for an order (via Paystack Card, Dedicated Virtual Account, or Paycode), the fulfillment webhook must execute the following state mutations inside **one single atomic `prisma.$transaction`**:

```ts
await prisma.$transaction(async (tx) => {
  // 1. Update Order status
  const updatedOrder = await tx.order.update({
    where: { id: order.id },
    data: {
      status: 'paid',
      paidAt: new Date(paidAt),
      paymentChannel: channel,
    },
  });

  // 2. Create confirmed SalesTransaction for the specific business
  const sale = await tx.salesTransaction.create({
    data: {
      businessId: order.businessId,
      amount: order.totalAmount,
      source: 'online_store',
      status: 'confirmed',
      referenceId: order.orderNumber,
      isTaxable: true,
      transactionDate: new Date(paidAt),
      customerName: order.customerName,
      description: `Online Store Order ${order.orderNumber}`,
      metadata: {
        storeId: order.storeId,
        orderId: order.id,
        channel,
      },
    },
  });

  // 3. Link Order to SalesTransaction
  await tx.order.update({
    where: { id: order.id },
    data: { linkedSaleId: sale.id },
  });

  // 4. Credit Central User Wallet (treasury cash pool)
  await WalletService.creditWallet(
    {
      userId: business.userId,
      businessId: order.businessId,
      amount: order.totalAmount,
      fee: 0, // Paystack transfer/processing fees accounted for
      reference: order.orderNumber,
      source: 'store_sale',
      linkedSaleId: sale.id,
      description: `Storefront order ${order.orderNumber} for ${business.businessName}`,
    },
    tx
  );
});
```

### Invariant 2: Two-Tier Inventory Reservation & Backorder Guarantee
- **Never discard or roll back confirmed revenue due to zero stock**.
- In the Nigerian retail market, once Paystack debits the customer's card or bank, cancelling the transaction creates customer friction, refund disputes, and chargeback exposure.
- If inventory is depleted between checkout initiation and webhook receipt:
  1. The payment is **strictly accepted**.
  2. The Order status is marked `paid`.
  3. The `fulfillmentStatus` is marked `'backordered'`.
  4. An urgent in-app and email alert is dispatched to the merchant to restock or fulfill manually.

### Invariant 3: Platform Collection & User Wallet Pooling
- Storefront checkouts collect directly into the platform Paystack master account.
- Subaccount auto-split is **not** applied at checkout time so funds enter the central user wallet.
- The 7.5% tax reserve remains tracked per business by the FIRS Tax Engine; the merchant can remit tax or withdraw operating profit at will.

### Invariant 4: Universal Reference Prefix Standardization
- Storefront orders strictly adhere to the prefix:
  `ORD-{YYYY}-{NNNNN}` (e.g. `ORD-2026-00042`)
- Webhook dispatchers distinguish orders immediately by inspecting `reference.startsWith('ORD-')`.
- Generic DVA sales auto-capture skips `ORD-*` references to prevent double-booking.

---

## 2. Domain Events Lifecycle

All side-effects run asynchronously post-commit via `TypedEventBus` (`src/core/events/`):

1. **`order.payment_confirmed`**:
   - Emitted by the webhook dispatcher once the transaction commits.
   - Handlers:
     - Sends customer receipt email with order summary.
     - Sends merchant push notification / WhatsApp order alert.
     - Decrements cached product catalog stock.
