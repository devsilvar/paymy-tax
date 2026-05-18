import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { initiatePaymentSchema, listPaymentsSchema } from '@/validators/payment.validator';
import * as paymentService from '@/services/payment.service';

export const initiatePayment = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { taxReportId, callbackUrl } = initiatePaymentSchema.parse(req.body);
  const result = await paymentService.initiatePayment(
    req.user!.userId,
    req.params.businessId,
    taxReportId,
    callbackUrl
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'Payment initiated successfully',
  });
});

export const listPayments = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = listPaymentsSchema.parse(req.query);
  const result = await paymentService.listPayments(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getPayment = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const payment = await paymentService.getPayment(
    req.user!.userId,
    req.params.businessId,
    req.params.paymentId
  );

  res.status(200).json({
    success: true,
    data: payment,
  });
});

export const verifyPayment = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const payment = await paymentService.verifyPayment(
    req.user!.userId,
    req.params.businessId,
    req.params.paymentId
  );

  res.status(200).json({
    success: true,
    data: payment,
    message: 'Payment verification complete',
  });
});

export const handleWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers['x-paystack-signature'] as string;
  const rawBody = (req as any).rawBody;

  if (!signature || !rawBody) {
    res.status(400).json({ success: false, message: 'Missing signature or body' });
    return;
  }

  await paymentService.processWebhook(signature, rawBody);

  res.status(200).json({ success: true });
});
