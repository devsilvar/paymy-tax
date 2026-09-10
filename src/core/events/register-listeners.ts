/**
 * Domain Event Listeners Registration
 *
 * Connects decoupled domain event handlers to the TypedEventBus.
 * All handlers execute post-commit, asynchronously, with individual error boundaries.
 */

import logger from '@/lib/logger';
import { eventBus } from './event-bus';

let listenersRegistered = false;

export function registerDomainEventListeners(): void {
  if (listenersRegistered) {
    logger.debug('[EventBus] Listeners already registered, skipping duplicate registration');
    return;
  }

  // 1. Payout Completed Listener
  eventBus.on('payout.completed', async (payload) => {
    logger.info('[EventBus:Listener] Payout completed successfully', {
      userId: payload.userId,
      payoutId: payload.payoutId,
      amount: payload.amount,
      reference: payload.reference,
    });
  });

  // 2. DVA Transfer Received Listener
  eventBus.on('dva.transfer_received', async (payload) => {
    logger.info('[EventBus:Listener] DVA transfer received', {
      accountNumber: payload.accountNumber,
      amount: payload.amount,
      reference: payload.reference,
      payerName: payload.payerName,
    });
  });

  // 3. Wallet Credited Listener
  eventBus.on('wallet.credited', async (payload) => {
    logger.info('[EventBus:Listener] User wallet credited', {
      userId: payload.userId,
      businessId: payload.businessId,
      amount: payload.amount,
      transactionId: payload.transactionId,
    });
  });

  // 4. Order Payment Confirmed Listener (Phase 4 Foundation)
  eventBus.on('order.payment_confirmed', async (payload) => {
    logger.info('[EventBus:Listener] Store order payment confirmed', {
      orderId: payload.orderId,
      storeId: payload.storeId,
      businessId: payload.businessId,
      userId: payload.userId,
      amount: payload.amount,
      orderNumber: payload.orderNumber,
      customerName: payload.customerName,
      itemCount: payload.items?.length ?? 0,
    });
  });

  // 5. Invoice Paid Listener
  eventBus.on('invoice.paid', async (payload) => {
    logger.info('[EventBus:Listener] Invoice paid notification', {
      invoiceId: payload.invoiceId,
      businessId: payload.businessId,
      userId: payload.userId,
      amount: payload.amount,
      invoiceNumber: payload.invoiceNumber,
      customerName: payload.customerName,
    });
  });

  listenersRegistered = true;
  logger.info('[EventBus] Domain event listeners registered successfully');
}
