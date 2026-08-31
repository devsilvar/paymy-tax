import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { setupPinSchema, verifyPinSchema, changePinSchema } from '@/validators/pin.validator';
import * as pinService from '@/services/pin.service';

export const getStatus = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await pinService.getPinStatus(req.user!.userId);
  res.json({ success: true, data: result });
});

export const setup = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = setupPinSchema.parse(req.body);
  const result = await pinService.setupPin(
    req.user!.userId,
    input,
    req.ip,
    req.get('user-agent')
  );
  res.json({ success: true, message: result.message });
});

export const verify = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { pin } = verifyPinSchema.parse(req.body);
  const result = await pinService.verifyPin(
    req.user!.userId,
    pin,
    req.ip,
    req.get('user-agent')
  );
  res.json({
    success: true,
    data: {
      valid: result.valid,
    },
    message: 'Transaction PIN verified successfully',
  });
});

export const change = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = changePinSchema.parse(req.body);
  const result = await pinService.changePin(
    req.user!.userId,
    input,
    req.ip,
    req.get('user-agent')
  );
  res.json({ success: true, message: result.message });
});
