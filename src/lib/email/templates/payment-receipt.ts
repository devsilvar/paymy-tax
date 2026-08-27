/**
 * Payment Receipt Email Template
 *
 * Professional, branded confirmation email dispatched when a tax payment is successfully confirmed.
 */

export interface PaymentReceiptEmailData {
  businessName: string;
  ownerName: string;
  amountFormatted: string;
  taxMonthLabel: string;
  paymentReference: string;
  paymentDate: string;
  receiptNumber: string;
}

export function generatePaymentReceiptHtml(data: PaymentReceiptEmailData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Receipt - PayMyTax</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; color: #334155;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8fafc;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08); border: 1px solid #e2e8f0;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 24px; text-align: center; background-color: #0f172a;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                PayMyTax
              </h1>
              <p style="margin: 6px 0 0; color: #10b981; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                Tax Payment Confirmed
              </p>
            </td>
          </tr>

          <!-- Amount Banner -->
          <tr>
            <td style="padding: 32px 32px 20px; text-align: center; background-color: #f0fdf4; border-bottom: 1px solid #bbf7d0;">
              <p style="margin: 0; color: #166534; font-size: 13px; font-weight: 600; text-transform: uppercase;">
                Total Tax Liability Settled
              </p>
              <h2 style="margin: 8px 0 0; color: #0f172a; font-size: 32px; font-weight: 800; letter-spacing: -0.5px;">
                ${data.amountFormatted}
              </h2>
              <p style="margin: 6px 0 0; color: #15803d; font-size: 13px; font-weight: 500;">
                Period: ${data.taxMonthLabel}
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 16px; color: #0f172a; font-size: 15px; line-height: 1.5;">
                Hello <strong>${data.ownerName}</strong>,
              </p>
              
              <p style="margin: 0 0 24px; color: #475569; font-size: 14px; line-height: 1.6;">
                Your tax settlement for <strong>${data.businessName}</strong> covering <strong>${data.taxMonthLabel}</strong> has been successfully processed and locked. An official PDF custody receipt is attached to this email for your tax compliance records.
              </p>

              <!-- Details Box -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 13px;">Receipt Number</td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #0f172a; font-size: 13px; font-weight: 600; text-align: right;">${data.receiptNumber}</td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 13px;">Payment Reference</td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #0f172a; font-size: 13px; font-weight: 600; text-align: right; font-family: monospace;">${data.paymentReference}</td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; color: #64748b; font-size: 13px;">Settlement Date</td>
                  <td style="padding: 12px 16px; color: #0f172a; font-size: 13px; font-weight: 600; text-align: right;">${data.paymentDate}</td>
                </tr>
              </table>

              <p style="margin: 0 0 12px; color: #64748b; font-size: 13px; line-height: 1.5;">
                <strong>Next steps:</strong> Your tax liability has been credited into our custody pool. Once the designated monthly batch remittance to FIRS is cleared, your dashboard will automatically update with the government-stamped FIRS Remittance Reference.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #f1f5f9; border-top: 1px solid #e2e8f0; text-align: center;">
              <p style="margin: 0 0 6px; color: #64748b; font-size: 12px;">
                PayMyTax by WallX • Nigeria SME Tax Compliance & Remittance
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 11px;">
                Need assistance? Contact <a href="mailto:support@paymytax.com" style="color: #10b981; text-decoration: none;">support@paymytax.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

export function generatePaymentReceiptText(data: PaymentReceiptEmailData): string {
  return `
PAYMYTAX - TAX PAYMENT RECEIPT
==================================================

Hello ${data.ownerName},

Your tax settlement for ${data.businessName} covering ${data.taxMonthLabel} has been successfully processed.

PAYMENT SUMMARY:
- Amount Paid: ${data.amountFormatted}
- Tax Period: ${data.taxMonthLabel}
- Receipt Number: ${data.receiptNumber}
- Payment Reference: ${data.paymentReference}
- Date: ${data.paymentDate}

Your official PDF receipt is attached to this email.

Thank you,
PayMyTax Team
support@paymytax.com
`;
}
