import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import * as receiptService from '@/services/receipt.service';

export const downloadTaxPaymentReceipt = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { buffer, filename } = await receiptService.getTaxPaymentReceipt(
      req.user!.userId,
      req.params.businessId,
      req.params.paymentId
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  }
);

export const downloadDvaTransferReceipt = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { buffer, filename } = await receiptService.getDvaTransferReceipt(
      req.user!.userId,
      req.params.businessId,
      req.params.saleId
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  }
);



export const downloadSalesReceipt = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { buffer, filename } = await receiptService.getSalesReceipt(
      req.user!.userId,
      req.params.businessId,
      req.params.saleId
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  }
);
