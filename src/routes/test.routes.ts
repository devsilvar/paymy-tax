import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Request, Response } from 'express';
import * as dvaService from '@/services/dva.service';
import prisma from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

const router = Router();

/**
 * TEST ONLY: Simulate a DVA transfer webhook from Paystack
 * 
 * POST /api/test/simulate-transfer
 * Body: {
 *   businessId: string,
 *   amount: number (in naira),
 *   customerName?: string,
 *   narration?: string
 * }
 */
router.post('/simulate-transfer', asyncHandler(async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    throw new AppError(403, 'Test endpoints disabled in production', 'FORBIDDEN');
  }

  const { businessId, amount, customerName, narration } = req.body;

  if (!businessId || !amount) {
    throw new AppError(400, 'businessId and amount are required', 'INVALID_INPUT');
  }

  // Get the business and its DVA
  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (!business.virtualAccountNumber) {
    throw new AppError(400, 'No virtual account set up for this business', 'NO_DVA');
  }

  // Generate a fake Paystack event
  const fakeEvent = {
    event: 'charge.success',
    data: {
      id: Math.floor(Math.random() * 1000000000),
      reference: `TEST-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      amount: amount * 100, // naira to kobo
      channel: 'dedicated_nuban',
      paid_at: new Date().toISOString(),
      narration: narration || 'Test transfer',
      customer: {
        first_name: customerName || 'Test',
        last_name: 'Customer',
      },
      dedicated_account: {
        account_number: business.virtualAccountNumber,
      },
      metadata: {
        purpose: narration || null,
      },
    },
  };

  // Process through the DVA webhook handler
  const processed = await dvaService.processDVATransferWebhook(fakeEvent);

  if (processed) {
    res.status(200).json({
      success: true,
      message: 'Transfer simulated successfully',
      data: {
        amount,
        accountNumber: business.virtualAccountNumber,
        reference: fakeEvent.data.reference,
      },
    });
  } else {
    throw new AppError(500, 'Failed to process simulated transfer', 'PROCESSING_ERROR');
  }
}));

/**
 * TEST ONLY: Get all businesses with their DVA info
 */
router.get('/businesses-with-dva', asyncHandler(async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    throw new AppError(403, 'Test endpoints disabled in production', 'FORBIDDEN');
  }

  const businesses = await prisma.business.findMany({
    where: {
      virtualAccountNumber: { not: null },
    },
    select: {
      id: true,
      businessName: true,
      virtualAccountNumber: true,
      virtualAccountBank: true,
      user: {
        select: {
          email: true,
        },
      },
    },
  });

  res.status(200).json({
    success: true,
    data: businesses,
  });
}));

// Debug: Check classifications
router.get('/check-classifications', asyncHandler(async (req: Request, res: Response) => {
  const count = await prisma.transactionClassification.count();
  const sample = await prisma.transactionClassification.findMany({ take: 5 });
  
  res.json({
    success: true,
    data: {
      count,
      sample,
      message: count === 0 ? 'No classifications found. Run: npm run prisma:seed' : 'OK'
    }
  });
}));

/**
 * Trigger an instant Paystack transfer to any bank account (OPay, etc.)
 * 
 * POST /api/v1/test/trigger-transfer
 * Body: {
 *   amount?: number (default: 740),
 *   accountNumber?: string (default: 8148434507),
 *   bankCode?: string (default: 999992 - OPay),
 *   reason?: string,
 *   secretKey?: string (optional live key override)
 * }
 */
router.post('/trigger-transfer', asyncHandler(async (req: Request, res: Response) => {
  const amount = Number(req.body.amount || 740);
  const accountNumber = String(req.body.accountNumber || '8148434507');
  const bankCode = String(req.body.bankCode || '999992');
  const reason = String(req.body.reason || 'PayMyTax Settlement Transfer');
  const secretKey = req.body.secretKey || process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new AppError(500, 'Paystack secret key not configured', 'CONFIG_ERROR');
  }

  // 1. Resolve Account Name
  let recipientName = 'Beneficiary';
  try {
    const resolveRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: { Authorization: `Bearer ${secretKey}` },
      }
    );
    const resolveJson: any = await resolveRes.json();
    if (resolveJson.status && resolveJson.data?.account_name) {
      recipientName = resolveJson.data.account_name;
    }
  } catch {
    // Non-blocking fallback
  }

  // 2. Create Transfer Recipient
  const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'nuban',
      name: recipientName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
      description: `Payout to ${recipientName}`,
    }),
  });
  const recipientJson: any = await recipientRes.json();
  if (!recipientJson.status) {
    throw new AppError(400, recipientJson.message || 'Failed to create transfer recipient', 'RECIPIENT_FAILED');
  }
  const recipientCode = recipientJson.data.recipient_code;

  // 3. Initiate Transfer
  const reference = `PMT-TRF-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const transferRes = await fetch('https://api.paystack.co/transfer', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'balance',
      amount: Math.round(amount * 100),
      recipient: recipientCode,
      reason,
      reference,
    }),
  });
  const transferJson: any = await transferRes.json();
  if (!transferJson.status) {
    throw new AppError(400, transferJson.message || 'Failed to initiate transfer', 'TRANSFER_FAILED');
  }

  res.status(200).json({
    success: true,
    message: 'Transfer initiated successfully via Paystack',
    data: {
      amount,
      recipientName,
      accountNumber,
      bankCode,
      reference,
      transferCode: transferJson.data.transfer_code,
      status: transferJson.data.status,
    },
  });
}));

export default router;
