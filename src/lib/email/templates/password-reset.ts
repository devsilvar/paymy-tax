/**
 * Password Reset Email Template
 * 
 * Professional, branded, and security-conscious email for password reset requests.
 * Follows email security best practices:
 * - Clear sender identification
 * - Explicit expiry time
 * - Security warnings
 * - Alternative action path
 */

export interface PasswordResetEmailData {
  resetLink: string;
  expiryMinutes: number;
  userEmail: string;
}

/**
 * Generate HTML email for password reset.
 * Uses inline CSS for maximum email client compatibility.
 */
export function generatePasswordResetHtml(data: PasswordResetEmailData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your PayMyTax Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">
                🔐 Reset Your Password
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 20px; color: #333333; font-size: 16px; line-height: 1.6;">
                Hi there,
              </p>
              
              <p style="margin: 0 0 20px; color: #333333; font-size: 16px; line-height: 1.6;">
                We received a request to reset the password for your <strong>PayMyTax</strong> account associated with <strong>${data.userEmail}</strong>.
              </p>

              <p style="margin: 0 0 30px; color: #333333; font-size: 16px; line-height: 1.6;">
                Click the button below to create a new password:
              </p>

              <!-- CTA Button -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="text-align: center; padding: 0 0 30px;">
                    <a href="${data.resetLink}" 
                       style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);">
                      Reset My Password
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Security Info Box -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 10px; color: #856404; font-size: 14px; font-weight: 600;">
                      ⏰ This link will expire in ${data.expiryMinutes} minutes
                    </p>
                    <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
                      For your security, this password reset link can only be used once. If you don't reset your password within ${data.expiryMinutes} minutes, you'll need to request a new link.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Alternative Link -->
              <p style="margin: 0 0 10px; color: #666666; font-size: 14px; line-height: 1.6;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin: 0 0 30px; color: #667eea; font-size: 14px; word-break: break-all;">
                <a href="${data.resetLink}" style="color: #667eea; text-decoration: underline;">
                  ${data.resetLink}
                </a>
              </p>

              <!-- Security Warning -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8d7da; border-left: 4px solid #dc3545; border-radius: 4px; margin-bottom: 20px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 10px; color: #721c24; font-size: 14px; font-weight: 600;">
                      🛡️ Didn't request this?
                    </p>
                    <p style="margin: 0; color: #721c24; font-size: 14px; line-height: 1.5;">
                      If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged. Someone may have entered your email address by mistake.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 10px; color: #666666; font-size: 14px; line-height: 1.6;">
                Best regards,<br>
                <strong>The PayMyTax Team</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f8f9fa; border-radius: 0 0 8px 8px; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px; color: #6c757d; font-size: 12px; line-height: 1.5; text-align: center;">
                This is an automated security email from PayMyTax.
              </p>
              <p style="margin: 0; color: #6c757d; font-size: 12px; line-height: 1.5; text-align: center;">
                For security reasons, never forward this email or share the reset link with anyone.
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

/**
 * Generate plain-text fallback email for password reset.
 * Required for email clients that don't support HTML and for accessibility.
 */
export function generatePasswordResetText(data: PasswordResetEmailData): string {
  return `
Reset Your PayMyTax Password
=============================

Hi there,

We received a request to reset the password for your PayMyTax account associated with ${data.userEmail}.

To reset your password, visit this link:
${data.resetLink}

IMPORTANT SECURITY INFORMATION:
- This link will expire in ${data.expiryMinutes} minutes
- This link can only be used once
- If you don't reset your password within ${data.expiryMinutes} minutes, you'll need to request a new link

DIDN'T REQUEST THIS?
If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged. Someone may have entered your email address by mistake.

For security reasons, never forward this email or share the reset link with anyone.

Best regards,
The PayMyTax Team

---
This is an automated security email from PayMyTax.
  `.trim();
}
