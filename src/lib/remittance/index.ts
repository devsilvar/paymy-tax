import { RemittanceTransport } from './types';
import { ManualTransport } from './manual.transport';
import { AppError } from '@/middleware/errorHandler';

// Resolve a remittance transport by name. Only `manual` exists today; future
// drivers (paystack_transfer, firs_api) register here when FIRS provides a
// mechanism. Unknown names fail loud rather than silently no-op.
export function getRemittanceTransport(name = 'manual'): RemittanceTransport {
  switch (name) {
    case 'manual':
      return new ManualTransport();
    default:
      throw new AppError(400, `Unsupported remittance transport: ${name}`, 'UNSUPPORTED_TRANSPORT');
  }
}

export * from './types';
