/**
 * Email sender abstraction.
 *
 * If `RESEND_API_KEY` is configured, sends real email via Resend.
 * Otherwise, logs the payload via Winston so the flow works end-to-end in dev
 * without provider credentials. The rest of the app calls `sendEmail()` — it
 * does not know (or care) which path is taken.
 */

import { Resend } from 'resend';
import config from '@/config';
import logger from '@/lib/logger';

export interface EmailAttachment {
  filename: string;
  /** Raw PDF/file bytes. */
  content: Buffer;
  contentType?: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  /** Whether a real send was attempted (true) or this was the dev-logger fallback (false). */
  delivered: boolean;
  /** Provider message id when available. */
  id?: string;
}

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!config.email.apiKey) return null;
  if (!resendClient) resendClient = new Resend(config.email.apiKey);
  return resendClient;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getResend();

  if (!client) {
    // Dev fallback — no provider configured. Log body preview (not full HTML to
    // keep logs readable) and return delivered=false so callers can surface
    // "not actually sent" state if they want.
    logger.warn('EMAIL (dev fallback — RESEND_API_KEY not set)', {
      to: input.to,
      subject: input.subject,
      htmlPreview: input.html.slice(0, 200),
      attachments: input.attachments?.map((a) => ({ filename: a.filename, bytes: a.content.length })),
    });
    return { delivered: false };
  }

  const { data, error } = await client.emails.send({
    from: config.email.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
    })),
  });

  if (error) {
    logger.error('Resend send failed', { to: input.to, subject: input.subject, error });
    throw new Error(`Email provider error: ${error.message || 'unknown'}`);
  }

  logger.info('Email sent', { to: input.to, subject: input.subject, providerId: data?.id });
  return { delivered: true, id: data?.id };
}
