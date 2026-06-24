import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  createInvoiceSchema,
  updateInvoiceSchema,
  invoicesQuerySchema,
  markInvoicePaidSchema,
  cancelInvoiceSchema,
} from '@/validators/invoice.validator';
import * as invoiceService from '@/services/invoice.service';

export const create = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = createInvoiceSchema.parse(req.body);
  const invoice = await invoiceService.createInvoice(
    req.user!.userId,
    req.params.businessId,
    input,
  );

  res.status(201).json({
    success: true,
    data: invoice,
    message: 'Invoice created successfully',
  });
});

export const getAll = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = invoicesQuerySchema.parse(req.query);
  const result = await invoiceService.listInvoices(
    req.user!.userId,
    req.params.businessId,
    query,
  );

  res.status(200).json({
    success: true,
    ...result,
  });
});

export const getById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const invoice = await invoiceService.getInvoiceById(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
  );

  res.status(200).json({
    success: true,
    data: invoice,
  });
});

export const update = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = updateInvoiceSchema.parse(req.body);
  const invoice = await invoiceService.updateInvoice(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    input,
  );

  res.status(200).json({
    success: true,
    data: invoice,
    message: 'Invoice updated successfully',
  });
});

export const remove = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await invoiceService.deleteInvoice(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
  );

  res.status(200).json({
    success: true,
    data: result,
    message: 'Invoice deleted successfully',
  });
});

export const send = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const invoice = await invoiceService.sendInvoice(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
  );

  res.status(200).json({
    success: true,
    data: invoice,
    message: 'Invoice sent',
  });
});

export const markPaid = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = markInvoicePaidSchema.parse(req.body ?? {});
  const invoice = await invoiceService.markInvoicePaid(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    input,
  );

  res.status(200).json({
    success: true,
    data: invoice,
    message: 'Invoice marked as paid and recorded as a sale',
  });
});

export const downloadPdf = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { buffer, filename } = await invoiceService.generateInvoicePdf(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
  );

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });
  res.send(buffer);
});

export const sendByWhatsApp = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const result = await invoiceService.sendInvoiceByWhatsApp(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
  );

  // Return JSON with PDF as base64 for easier frontend handling
  res.status(200).json({
    success: true,
    data: result.invoice,
    message: 'Invoice ready to send via WhatsApp',
    meta: {
      waUrl: result.waUrl,
      message: result.message,
      pdfUrl: result.pdfUrl,
      to: result.to,
      filename: result.filename,
      pdfBase64: result.pdfBuffer.toString('base64'),
    },
  });
});

export const cancel = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = cancelInvoiceSchema.parse(req.body ?? {});
  const invoice = await invoiceService.cancelInvoice(
    req.user!.userId,
    req.params.businessId,
    req.params.id,
    input,
  );

  res.status(200).json({
    success: true,
    data: invoice,
    message: 'Invoice cancelled',
  });
});

// Public PDF — accessed by invoice recipients via the shareToken in their
// WhatsApp message. No auth header required; the token IS the auth.
export const downloadPublicPdf = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { buffer, filename } = await invoiceService.getPublicInvoicePdfByToken(
    req.params.token,
  );

  res.set({
    'Content-Type': 'application/pdf',
    // Inline so mobile browsers preview the PDF instead of forcing a download —
    // a customer who taps the WA link expects to see the invoice, not an
    // unfamiliar file dropping into Downloads.
    'Content-Disposition': `inline; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
    // Short cache — the SME might edit the invoice between sends. 5 minutes is
    // long enough to absorb retries / a customer reloading, short enough that
    // an updated PDF surfaces quickly.
    'Cache-Control': 'private, max-age=300',
  });
  res.send(buffer);
});
