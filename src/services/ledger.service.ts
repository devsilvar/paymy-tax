import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { LedgerQueryInput } from '@/validators/ledger.validator';

function toNumber(val: any): number {
  if (val === null || val === undefined) return 0;
  return typeof val === 'number' ? val : Number(val);
}

export interface UnifiedLedgerRow {
  id: string;
  scope: 'dva_bank' | 'general_sales' | 'tax_outflow';
  entryType: 'credit' | 'debit';
  sourceType: 'dva_transfer' | 'manual_sale' | 'invoice_payment' | 'pos' | 'tax_payment' | 'refund';
  amount: number;
  runningBalance: number;
  classification: string;
  description: string;
  reference: string;
  date: string;
  status: 'settled' | 'pending' | 'reversed' | 'refunded';
  counterparty: string;
  isTaxable: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface UnifiedLedgerResponse {
  scope: 'dva_bank' | 'all_income';
  summary: {
    openingBalance: number;
    totalCredits: number;
    totalDebits: number;
    closingBalance: number;
  };
  data: UnifiedLedgerRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export async function getUnifiedLedger(
  userId: string,
  businessId: string,
  query: LedgerQueryInput
): Promise<UnifiedLedgerResponse> {
  await verifyBusinessOwnership(userId, businessId);

  const scope = query.scope;
  const fromDate = query.from ? new Date(`${query.from}T00:00:00.000Z`) : null;
  const toDate = query.to ? new Date(`${query.to}T23:59:59.999Z`) : null;

  // ── 1. Calculate Opening Balance before `fromDate` ──────────
  let openingBalance = 0;

  if (fromDate) {
    if (scope === 'dva_bank') {
      const [preCredits, preDebits] = await Promise.all([
        prisma.salesTransaction.aggregate({
          where: {
            businessId,
            source: 'bank_transfer',
            status: 'confirmed',
            transactionDate: { lt: fromDate },
          },
          _sum: { amount: true },
        }),
        prisma.taxPayment.aggregate({
          where: {
            businessId,
            paymentStatus: 'completed',
            createdAt: { lt: fromDate },
          },
          _sum: { amountPaid: true },
        }),
      ]);

      const sumCredits = toNumber(preCredits._sum.amount);
      const sumDebits = toNumber(preDebits._sum.amountPaid);
      openingBalance = sumCredits - sumDebits;
    } else {
      // all_income
      const preSales = await prisma.salesTransaction.aggregate({
        where: {
          businessId,
          status: 'confirmed',
          transactionDate: { lt: fromDate },
        },
        _sum: { amount: true },
      });
      openingBalance = toNumber(preSales._sum.amount);
    }
  }

  // ── 2. Fetch Transactions in Window ─────────────────────────
  const salesWhere: any = { businessId };
  if (scope === 'dva_bank') {
    salesWhere.source = 'bank_transfer';
  }
  if (fromDate || toDate) {
    salesWhere.transactionDate = {};
    if (fromDate) salesWhere.transactionDate.gte = fromDate;
    if (toDate) salesWhere.transactionDate.lte = toDate;
  }

  const [salesRows, taxPaymentRows] = await Promise.all([
    query.type === 'debit' && scope === 'dva_bank'
      ? Promise.resolve([])
      : prisma.salesTransaction.findMany({
          where: salesWhere,
          include: { classification: true },
          orderBy: { transactionDate: 'asc' },
        }),
    scope === 'dva_bank' && query.type !== 'credit'
      ? prisma.taxPayment.findMany({
          where: {
            businessId,
            paymentStatus: 'completed',
            ...(fromDate || toDate
              ? {
                  createdAt: {
                    ...(fromDate ? { gte: fromDate } : {}),
                    ...(toDate ? { lte: toDate } : {}),
                  },
                }
              : {}),
          },
          include: { taxReport: true },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  // ── 3. Normalize into Unified Array ─────────────────────────
  interface RawEntry {
    sortDate: Date;
    item: UnifiedLedgerRow;
  }

  const merged: RawEntry[] = [];

  for (const s of salesRows) {
    const rawDate = s.transactionDate || s.createdAt;
    const dateObj = new Date(rawDate);
    const amount = toNumber(s.amount);

    let sourceType: UnifiedLedgerRow['sourceType'] = 'manual_sale';
    if (s.source === 'bank_transfer') sourceType = 'dva_transfer';
    else if (s.source === 'pos') sourceType = 'pos';
    else if (s.source === 'invoice') sourceType = 'invoice_payment';

    merged.push({
      sortDate: dateObj,
      item: {
        id: s.id,
        scope: s.source === 'bank_transfer' ? 'dva_bank' : 'general_sales',
        entryType: 'credit',
        sourceType,
        amount,
        runningBalance: 0, // Calculated below
        classification: s.classification?.name || s.finalClassification || 'revenue',
        description: s.description || (s.source === 'bank_transfer' ? 'DVA Transfer Inflow' : 'Sales Revenue'),
        reference: s.referenceId || s.id,
        date: dateObj.toISOString(),
        status: s.status === 'confirmed' ? 'settled' : s.status === 'reversed' ? 'reversed' : 'pending',
        counterparty: s.customerName || s.customerHint || 'Customer',
        isTaxable: s.isTaxable,
        metadata: s.metadata as Record<string, unknown> | null,
      },
    });
  }

  for (const p of taxPaymentRows) {
    const rawDate = p.paymentDate || p.createdAt;
    const dateObj = new Date(rawDate);
    const amount = toNumber(p.amountPaid);
    const monthLabel = p.taxReport?.taxMonth
      ? new Date(p.taxReport.taxMonth).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' })
      : 'Period';

    merged.push({
      sortDate: dateObj,
      item: {
        id: p.id,
        scope: 'tax_outflow',
        entryType: 'debit',
        sourceType: 'tax_payment',
        amount,
        runningBalance: 0,
        classification: 'tax_payment',
        description: `FIRS Tax Settlement (${monthLabel})`,
        reference: p.transactionReference,
        date: dateObj.toISOString(),
        status: p.paymentStatus === 'completed' ? 'settled' : p.paymentStatus === 'refunded' ? 'refunded' : 'pending',
        counterparty: 'Federal Inland Revenue Service (FIRS)',
        isTaxable: false,
        metadata: p.gatewayResponse as Record<string, unknown> | null,
      },
    });
  }

  // Sort chronologically (oldest to newest for running balance math)
  merged.sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime());

  // ── 4. Calculate Chronological Running Balance & Totals ───────
  let currentBalance = openingBalance;
  let totalCredits = 0;
  let totalDebits = 0;

  for (const entry of merged) {
    if (entry.item.entryType === 'credit') {
      currentBalance += entry.item.amount;
      totalCredits += entry.item.amount;
    } else {
      currentBalance -= entry.item.amount;
      totalDebits += entry.item.amount;
    }
    entry.item.runningBalance = currentBalance;
  }

  const closingBalance = currentBalance;

  // ── 5. Apply Search Filter if requested ──────────────────────
  let filtered = merged.map((m) => m.item);
  if (query.search) {
    const q = query.search.toLowerCase();
    filtered = filtered.filter(
      (it) =>
        it.description.toLowerCase().includes(q) ||
        it.reference.toLowerCase().includes(q) ||
        it.counterparty.toLowerCase().includes(q) ||
        it.classification.toLowerCase().includes(q)
    );
  }

  // Reverse to newest-first for standard statement presentation
  filtered.reverse();

  // ── 6. Pagination ────────────────────────────────────────────
  const total = filtered.length;
  const totalPages = Math.ceil(total / query.limit) || 1;
  const page = Math.min(query.page, totalPages);
  const offset = (page - 1) * query.limit;
  const paginatedItems = filtered.slice(offset, offset + query.limit);

  logger.info('Unified ledger queried', {
    businessId,
    scope,
    total,
    page,
    openingBalance,
    closingBalance,
  });

  return {
    scope,
    summary: {
      openingBalance,
      totalCredits,
      totalDebits,
      closingBalance,
    },
    data: paginatedItems,
    pagination: {
      page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}
