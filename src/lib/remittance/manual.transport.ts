import { RemittanceTransport, RecordRemittanceParams, RemittanceResult } from './types';

// Manual transport — the only driver until FIRS provides a real mechanism.
// The admin has already paid FIRS by whatever means (bank transfer, Paystack
// link, etc.) and is recording proof: a reference and an optional receipt URL.
// `submit` just echoes that back with a server timestamp. A future real driver
// (e.g. PaystackTransferTransport) would implement the same interface and
// perform the actual transfer here, returning the provider's own ref/timestamp.
export class ManualTransport implements RemittanceTransport {
  readonly name = 'manual';

  async submit(params: RecordRemittanceParams): Promise<RemittanceResult> {
    return {
      firsReference: params.firsReference,
      firsReceiptUrl: params.firsReceiptUrl,
      remittedAt: new Date(),
    };
  }
}
