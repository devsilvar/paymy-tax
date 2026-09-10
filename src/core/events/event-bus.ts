/**
 * Typed Domain Event Bus
 * 
 * An in-process, zero-dependency event bus for post-commit domain events.
 * 
 * Architectural Invariants:
 * 1. Financial state changes (Order -> Sale -> WalletTransaction -> balance increment)
 *    MUST be committed inside the caller's atomic prisma.$transaction block.
 * 2. Events emitted via this bus are strictly for non-financial side effects:
 *    notifications, receipts, reminders, and cache invalidation.
 * 3. All listener executions are wrapped in error boundaries so listener failures
 *    never crash the host process or affect other listeners.
 * 
 * @author WallX Engineering Team
 */

import { EventEmitter } from 'events';
import logger from '@/lib/logger';

export interface AppDomainEvents {
  'order.payment_confirmed': {
    orderId: string;
    storeId: string;
    businessId: string;
    userId: string;
    amount: number;
    orderNumber: string;
    customerName: string;
    customerPhone: string;
    items: Array<{ name: string; quantity: number; unitPrice: number }>;
  };
  'invoice.paid': {
    invoiceId: string;
    businessId: string;
    userId: string;
    amount: number;
    invoiceNumber: string;
    customerName: string;
    paymentDate: Date;
  };
  'dva.transfer_received': {
    accountNumber: string;
    amount: number;
    reference: string;
    payerName?: string;
    rawEvent: unknown;
  };
  'wallet.credited': {
    userId: string;
    businessId?: string | null;
    amount: number;
    transactionId: string;
  };
  'payout.completed': {
    userId: string;
    payoutId: string;
    amount: number;
    reference: string;
  };
}

export class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(30);
  }

  /**
   * Emits a typed domain event to all registered listeners.
   */
  emit<K extends keyof AppDomainEvents>(event: K, payload: AppDomainEvents[K]): boolean {
    logger.info(`[EventBus] Emitting event: ${String(event)}`, { event });
    return this.emitter.emit(event, payload);
  }

  /**
   * Subscribes an asynchronous or synchronous listener to a domain event.
   * Catches and logs errors to isolate failures.
   */
  on<K extends keyof AppDomainEvents>(
    event: K,
    handler: (payload: AppDomainEvents[K]) => Promise<void> | void
  ): void {
    this.emitter.on(event, async (payload) => {
      try {
        await handler(payload);
      } catch (err) {
        logger.error(`[EventBus] Error handling event ${String(event)}`, {
          event,
          error: err instanceof Error ? err.message : err,
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    });
  }

  /**
   * Removes a listener from the specified domain event.
   */
  off<K extends keyof AppDomainEvents>(
    event: K,
    handler: (...args: any[]) => void
  ): void {
    this.emitter.off(event, handler);
  }

  /**
   * Removes all listeners, primarily used for test teardown.
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  /**
   * Returns listener count for a specific event.
   */
  listenerCount<K extends keyof AppDomainEvents>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}

export const eventBus = new TypedEventBus();
export default eventBus;
