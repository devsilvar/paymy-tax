import { AppError } from '@/middleware/errorHandler';

/**
 * Determines whether a caught error from a Paystack transfer call is "ambiguous" —
 * meaning we cannot know whether Paystack actually queued the transfer or not.
 *
 * Ambiguous errors include:
 * - PAYSTACK_TIMEOUT (our AbortSignal fired before Paystack responded)
 * - PAYSTACK_TRANSPORT_ERROR (socket dropped, ECONNRESET, etc.)
 * - Any 5xx gateway error (502/503/504 from Paystack infrastructure)
 *
 * Deterministic errors (4xx from Paystack, e.g. invalid NUBAN, insufficient balance)
 * are NOT ambiguous — Paystack definitively rejected the request.
 *
 * When this returns true, callers MUST NOT release locked wallet funds because
 * the transfer may have been accepted by Paystack before the connection broke.
 * The payout reconciliation cron will resolve the final state.
 */
export function isAmbiguousTransferError(err: unknown): boolean {
  if (err instanceof AppError) {
    return (
      err.code === 'PAYSTACK_TIMEOUT' ||
      err.code === 'PAYSTACK_TRANSPORT_ERROR' ||
      err.statusCode >= 500
    );
  }

  // Catch raw Node.js fetch errors that bypassed our AppError wrapping
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || err.name === 'AbortError';
  }

  return false;
}
