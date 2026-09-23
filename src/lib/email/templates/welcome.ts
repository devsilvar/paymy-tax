/**
 * Welcome Email Template
 *
 * Sent once, right after a user completes registration.
 */

export interface WelcomeEmailData {
  userEmail: string;
  dashboardLink: string;
}

export function generateWelcomeHtml(data: WelcomeEmailData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to PayMyTax</title>
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
                Welcome Aboard
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px 32px;">
              <p style="margin: 0 0 20px; color: #334155; font-size: 16px; line-height: 1.6;">
                Hi there,
              </p>

              <p style="margin: 0 0 20px; color: #334155; font-size: 16px; line-height: 1.6;">
                Your PayMyTax account (<strong>${data.userEmail}</strong>) is ready. You can now track sales and expenses, calculate your monthly tax, and pay FIRS directly from the dashboard.
              </p>

              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="text-align: center; padding: 10px 0 30px;">
                    <a href="${data.dashboardLink}"
                       style="display: inline-block; padding: 16px 40px; background-color: #10b981; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                      Go to Dashboard
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 10px; color: #334155; font-size: 15px; line-height: 1.6;">
                A few things to get started:
              </p>
              <ul style="margin: 0 0 24px; padding-left: 20px; color: #334155; font-size: 15px; line-height: 1.8;">
                <li>Add your business so we can track its numbers separately</li>
                <li>Record your first sale or expense</li>
                <li>Run your first tax calculation — it's just 7.5% of gross profit</li>
              </ul>

              <p style="margin: 0 0 10px; color: #64748b; font-size: 14px; line-height: 1.6;">
                Best regards,<br>
                <strong>The PayMyTax Team</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.5; text-align: center;">
                This is an automated message from PayMyTax. If you didn't create this account, please contact support.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

export function generateWelcomeText(data: WelcomeEmailData): string {
  return `
Welcome to PayMyTax
====================

Hi there,

Your PayMyTax account (${data.userEmail}) is ready. You can now track sales and expenses, calculate your monthly tax, and pay FIRS directly from the dashboard.

Go to your dashboard:
${data.dashboardLink}

A few things to get started:
- Add your business so we can track its numbers separately
- Record your first sale or expense
- Run your first tax calculation - it's just 7.5% of gross profit

Best regards,
The PayMyTax Team

---
This is an automated message from PayMyTax. If you didn't create this account, please contact support.
  `.trim();
}
