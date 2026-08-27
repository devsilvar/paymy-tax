import { z } from 'zod';

const TRIVIAL_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '0123', '1234', '2345', '3456', '4567', '5678', '6789',
  '9876', '8765', '7654', '6543', '5432', '4321', '3210',
  '2580', '0852',
]);

function isNonTrivialPin(pin: string): boolean {
  return !TRIVIAL_PINS.has(pin);
}

export const setupPinSchema = z.object({
  pin: z
    .string()
    .regex(/^\d{4}$/, 'Transaction PIN must be exactly 4 digits')
    .refine(isNonTrivialPin, 'PIN is too simple (avoid repeated or sequential digits like 1234 or 0000)'),
  password: z.string().min(1, 'Account password is required for security verification'),
});

export const verifyPinSchema = z.object({
  pin: z.string().regex(/^\d{4}$/, 'Transaction PIN must be exactly 4 digits'),
});

export const changePinSchema = z
  .object({
    currentPin: z.string().regex(/^\d{4}$/, 'Current PIN must be 4 digits').optional(),
    password: z.string().min(1, 'Account password').optional(),
    newPin: z
      .string()
      .regex(/^\d{4}$/, 'New PIN must be exactly 4 digits')
      .refine(isNonTrivialPin, 'New PIN is too simple (avoid repeated or sequential digits like 1234 or 0000)'),
  })
  .refine((data) => data.currentPin || data.password, {
    message: 'Either current PIN or account password is required',
    path: ['currentPin'],
  });

export type SetupPinInput = z.infer<typeof setupPinSchema>;
export type VerifyPinInput = z.infer<typeof verifyPinSchema>;
export type ChangePinInput = z.infer<typeof changePinSchema>;
