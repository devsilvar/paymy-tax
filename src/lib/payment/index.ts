import { PaymentProvider } from './types';
import { PaystackProvider } from './paystack.provider';

export function getPaymentProvider(): PaymentProvider {
  return new PaystackProvider();
}

export * from './types';
