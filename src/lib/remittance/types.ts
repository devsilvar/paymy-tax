// FIRS remittance transport abstraction.
//
// FIRS has not given us a payment API. The eventual mechanism is unknown — it
// could be a Paystack link, a bank transfer, or a real API later. Rather than
// build against an endpoint that doesn't exist, we define a transport interface
// so a future driver (paystack_transfer / firs_api) can drop in WITHOUT touching
// the data model or the service. Today the only driver is `manual`: an admin
// pays FIRS out-of-band and records the reference + receipt here.

export interface RecordRemittanceParams {
  remittanceId: string;
  firsReference: string;
  firsReceiptUrl?: string;
  note?: string;
}

export interface RemittanceResult {
  firsReference: string;
  firsReceiptUrl?: string;
  remittedAt: Date;
}

export interface RemittanceTransport {
  readonly name: string;
  submit(params: RecordRemittanceParams): Promise<RemittanceResult>;
}
