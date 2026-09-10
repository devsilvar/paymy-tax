import { TypedEventBus, AppDomainEvents } from '@/core/events/event-bus';

describe('TypedEventBus', () => {
  let bus: TypedEventBus;

  beforeEach(() => {
    bus = new TypedEventBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  it('delivers typed payload to registered listener', async () => {
    const received: Array<AppDomainEvents['wallet.credited']> = [];

    bus.on('wallet.credited', (payload) => {
      received.push(payload);
    });

    const payload: AppDomainEvents['wallet.credited'] = {
      userId: 'user-123',
      businessId: 'biz-456',
      amount: 50000,
      transactionId: 'tx-789',
    };

    bus.emit('wallet.credited', payload);

    // Yield macro-task to let async handler run
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it('dispatches to multiple listeners on the same event', async () => {
    let callA = false;
    let callB = false;

    bus.on('order.payment_confirmed', () => {
      callA = true;
    });

    bus.on('order.payment_confirmed', () => {
      callB = true;
    });

    bus.emit('order.payment_confirmed', {
      orderId: 'ord-1',
      storeId: 'store-1',
      businessId: 'biz-1',
      userId: 'usr-1',
      amount: 12000,
      orderNumber: 'ORD-2026-001',
      customerName: 'Amina Bello',
      customerPhone: '08012345678',
      items: [{ name: 'Bread', quantity: 2, unitPrice: 6000 }],
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(callA).toBe(true);
    expect(callB).toBe(true);
  });

  it('isolates listener errors so other listeners still execute without bubbling', async () => {
    let secondListenerExecuted = false;

    bus.on('dva.transfer_received', () => {
      throw new Error('Simulated listener failure in notification worker');
    });

    bus.on('dva.transfer_received', () => {
      secondListenerExecuted = true;
    });

    // Emitting should not throw
    expect(() => {
      bus.emit('dva.transfer_received', {
        accountNumber: '9901234567',
        amount: 25000,
        reference: 'DVA-REF-100',
        payerName: 'Chidi Obi',
        rawEvent: {},
      });
    }).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));

    expect(secondListenerExecuted).toBe(true);
  });

  it('handles events with no registered listeners gracefully', () => {
    const emitted = bus.emit('payout.completed', {
      userId: 'user-999',
      payoutId: 'pay-888',
      amount: 100000,
      reference: 'PAYOUT-REF-01',
    });

    expect(emitted).toBe(false);
  });

  it('tracks listener counts accurately', () => {
    const handler = () => {};
    expect(bus.listenerCount('invoice.paid')).toBe(0);

    bus.on('invoice.paid', handler);
    expect(bus.listenerCount('invoice.paid')).toBe(1);

    bus.removeAllListeners();
    expect(bus.listenerCount('invoice.paid')).toBe(0);
  });
});
