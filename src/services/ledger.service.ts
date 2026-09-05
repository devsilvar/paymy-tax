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
  sourceType: 'dva_transfer' | 'manual_sale' | 'invoice_payment' | 'pos' | 'tax_payment' | 'refund' | 'payout';
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
    totalTaxDebits: number;
    totalPayoutDebits: number;
    totalSplitDebits: number;
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
      const [preCredits, preTaxDebits, prePayoutDebits, preSplitSales] = await Promise.all([
        prisma.salesTransaction.aggregate({
          where: {
            businessId,
            source: 'bank_transfer',
            // Settled statuses only — 'confirmed' is canonical, 'completed'
            // is the legacy manual-entry status.
            status: { in: ['confirmed', 'completed'] },
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
        prisma.settlementPayout.aggregate({
          where: {
            businessId,
            status: 'completed',
            createdAt: { lt: fromDate },
          },
          _sum: { amount: true },
        }),
        // Auto-split sweeps: for split-settled transactions prior to the window,
        // the swept amount (amount - platformRetained) left the DVA. We need
        // to aggregate both fields to compute the swept total.
        prisma.salesTransaction.findMany({
          where: {
            businessId,
            source: 'bank_transfer',
            status: { in: ['confirmed', 'completed'] },
            settledViaSplit: true,
            transactionDate: { lt: fromDate },
          },
          select: { amount: true, platformRetained: true },
        }),
      ]);

      const sumCredits = toNumber(preCredits._sum.amount);
      const sumTaxDebits = toNumber(preTaxDebits._sum.amountPaid);
      const sumPayoutDebits = toNumber(prePayoutDebits._sum.amount);
      // Compute prior auto-split sweep total
      let sumSplitDebits = 0;
      for (const s of preSplitSales) {
        const swept = Math.round((toNumber(s.amount) - toNumber(s.platformRetained)) * 100) / 100;
        if (swept > 0) sumSplitDebits += swept;
      }
      openingBalance = sumCredits - sumTaxDebits - sumPayoutDebits - sumSplitDebits;
    } else {
      // all_income
      const preSales = await prisma.salesTransaction.aggregate({
        where: {
          businessId,
          status: { in: ['confirmed', 'completed'] },
          transactionDate: { lt: fromDate },
        },
        _sum: { amount: true },
      });
      openingBalance = toNumber(preSales._sum.amount);
    }
  }

  // ── 2. Fetch Transactions in Window ─────────────────────────
  //
  // IMPORTANT: We always fetch ALL transaction types (credits AND debits)
  // regardless of `query.type`. The type filter is applied later for the
  // paginated row list, but the summary KPIs are computed on the full set
  // so that filtering by "debits only" doesn't zero out "Total Inflows".
  const salesWhere: any = { businessId };
  if (scope === 'dva_bank') {
    salesWhere.source = 'bank_transfer';
  }
  if (fromDate || toDate) {
    salesWhere.transactionDate = {};
    if (fromDate) salesWhere.transactionDate.gte = fromDate;
    if (toDate) salesWhere.transactionDate.lte = toDate;
  }

  const [salesRows, taxPaymentRows, payoutRows] = await Promise.all([
    prisma.salesTransaction.findMany({
      where: salesWhere,
      include: { classification: true },
      orderBy: { transactionDate: 'asc' },
    }),
    scope === 'dva_bank'
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
    scope === 'dva_bank'
      ? prisma.settlementPayout.findMany({
          where: {
            businessId,
            status: 'completed',
            ...(fromDate || toDate
              ? {
                  createdAt: {
                    ...(fromDate ? { gte: fromDate } : {}),
                    ...(toDate ? { lte: toDate } : {}),
                  },
                }
              : {}),
          },
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
        status:
          s.status === 'confirmed' || s.status === 'completed'
            ? 'settled'
            : s.status === 'reversed'
              ? 'reversed'
              : 'pending',
        counterparty: s.customerName || s.customerHint || 'Customer',
        isTaxable: s.isTaxable,
        metadata: s.metadata as Record<string, unknown> | null,
      },
    });

    // Auto-split sweep: when a DVA transfer was settled via Paystack's
    // subaccount split, the portion (amount - platformRetained) was
    // automatically swept to the SME's connected bank account on T+1.
    // Record this as an explicit debit on the DVA ledger so the closing
    // balance reflects the actual cash remaining on the platform.
    if (scope === 'dva_bank' && s.settledViaSplit && s.platformRetained !== null) {
      const swept = Math.round((amount - toNumber(s.platformRetained)) * 100) / 100;
      if (swept > 0) {
        merged.push({
          sortDate: dateObj,
          item: {
            id: `${s.id}-split`,
            scope: 'dva_bank',
            entryType: 'debit',
            sourceType: 'payout',
            amount: swept,
            runningBalance: 0,
            classification: 'auto_split_settlement',
            description: 'Auto-Split Settlement to Bank (T+1)',
            reference: s.referenceId || s.id,
            date: dateObj.toISOString(),
            status: 'settled',
            counterparty: 'Payout Bank Account (Auto-Settled)',
            isTaxable: false,
            metadata: {
              originalAmount: amount,
              platformRetained: toNumber(s.platformRetained),
              swept,
              settlementType: 'auto_split_t1',
            },
          },
        });
      }
    }
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

  for (const p of payoutRows) {
    const rawDate = p.completedAt || p.initiatedAt || p.createdAt;
    const dateObj = new Date(rawDate);
    const amount = toNumber(p.amount);
    const last4 = p.destinationAccountNum ? p.destinationAccountNum.slice(-4) : '••••';

    merged.push({
      sortDate: dateObj,
      item: {
        id: p.id,
        scope: 'dva_bank',
        entryType: 'debit',
        sourceType: 'payout',
        amount,
        runningBalance: 0,
        classification: 'settlement_payout',
        description: `Balance Payout to ${p.destinationBankName} (•••• ${last4})`,
        reference: p.transferReference,
        date: dateObj.toISOString(),
        status: 'settled',
        counterparty: p.destinationAccountName || p.destinationBankName,
        isTaxable: false,
        metadata: {
          fee: toNumber(p.fee),
          netAmount: toNumber(p.netAmount),
          destinationBank: p.destinationBankName,
          accountNumber: p.destinationAccountNum,
        },
      },
    });
  }

  // Sort chronologically (oldest to newest for running balance math).
  // Tie-breaker: credits before debits at the same timestamp to prevent
  // transient negative running balances.
  merged.sort((a, b) => {
    const diff = a.sortDate.getTime() - b.sortDate.getTime();
    if (diff !== 0) return diff;
    // Credits first at same timestamp
    if (a.item.entryType === 'credit' && b.item.entryType === 'debit') return -1;
    if (a.item.entryType === 'debit' && b.item.entryType === 'credit') return 1;
    return 0;
  });

  // ── 4. Calculate Chronological Running Balance & Totals ───────
  //
  // Summary totals are computed on ALL entries in the window — they are
  // filter-independent. The `type` and `search` filters only affect
  // which rows appear in the paginated list (Step 5), not the KPI cards.
  let currentBalance = openingBalance;
  let totalCredits = 0;
  let totalDebits = 0;
  let totalTaxDebits = 0;
  let totalPayoutDebits = 0;
  let totalSplitDebits = 0;

  for (const entry of merged) {
    if (entry.item.entryType === 'credit') {
      currentBalance += entry.item.amount;
      totalCredits += entry.item.amount;
    } else {
      currentBalance -= entry.item.amount;
      totalDebits += entry.item.amount;
      // Categorize debits
      if (entry.item.sourceType === 'tax_payment') {
        totalTaxDebits += entry.item.amount;
      } else if (entry.item.classification === 'auto_split_settlement') {
        totalSplitDebits += entry.item.amount;
      } else {
        totalPayoutDebits += entry.item.amount;
      }
    }
    entry.item.runningBalance = Math.round(currentBalance * 100) / 100;
  }

  const closingBalance = Math.round(currentBalance * 100) / 100;

  // ── 5. Apply Type & Search Filters (row-level only) ──────────
  let filtered = merged.map((m) => m.item);

  // Type filter — only affects the row list, not the summary
  if (query.type === 'credit') {
    filtered = filtered.filter((it) => it.entryType === 'credit');
  } else if (query.type === 'debit') {
    filtered = filtered.filter((it) => it.entryType === 'debit');
  }

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
      totalTaxDebits: Math.round(totalTaxDebits * 100) / 100,
      totalPayoutDebits: Math.round(totalPayoutDebits * 100) / 100,
      totalSplitDebits: Math.round(totalSplitDebits * 100) / 100,
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
