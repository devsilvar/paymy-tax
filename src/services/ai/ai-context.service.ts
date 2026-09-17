import prisma from '@/lib/prisma';
import { verifyBusinessOwnership } from '@/lib/ownership';
import { toNumber, TAXABLE_SALES_WHERE } from '@/shared/helpers';

export interface BusinessFinancialContext {
  business: {
    id: string;
    name: string;
    industry: string | null;
    currency: string;
    targetProfitMarginPercent: number;
    taxId: string | null;
  };
  currentMonth: {
    periodName: string;
    totalSales: number;
    totalExpenses: number;
    grossProfit: number;
    profitMarginPercent: number;
    isOperatingLoss: boolean;
    taxPayable: number;
    taxRatePercent: number;
    isFinalized: boolean;
    paymentStatus: string;
  };
  topExpenseDrivers: Array<{
    category: string;
    amount: number;
    sharePercent: number;
  }>;
  invoicingHealth: {
    overdueInvoicesCount: number;
    overdueAmount: number;
    unpaidSentCount: number;
    unpaidSentAmount: number;
  };
  recentTrends: Array<{
    month: string;
    sales: number;
    expenses: number;
    grossProfit: number;
    marginPercent: number;
    taxPayable: number;
    isPaid: boolean;
  }>;
  complianceAlerts: string[];
}

/**
 * Builds an aggregated, real-time financial health profile for an SME.
 * Pre-computes exact figures server-side to prevent LLM hallucinations.
 * Strictly excludes any sensitive personal identifiers (BVN, NIN, passwords).
 */
export async function buildBusinessFinancialContext(
  businessId: string,
  userId: string
): Promise<{ context: BusinessFinancialContext; summaryText: string }> {
  // 1. Verify business ownership
  const business = await verifyBusinessOwnership(userId, businessId);

  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const monthFilter = { gte: currentMonthStart, lte: currentMonthEnd };

  // 2. Fetch concurrent aggregations in parallel for low latency (<50ms)
  const [
    salesAgg,
    expenseAgg,
    categoryGroups,
    currentReport,
    unpaidInvoices,
    recentReports,
    activeReminders,
  ] = await Promise.all([
    // Live Sales for current month
    prisma.salesTransaction.aggregate({
      where: {
        businessId,
        transactionDate: monthFilter,
        ...TAXABLE_SALES_WHERE,
      },
      _sum: { amount: true },
    }),
    // Live Expenses for current month
    prisma.expense.aggregate({
      where: {
        businessId,
        expenseDate: monthFilter,
        isDeductible: true,
      },
      _sum: { amount: true },
    }),
    // Top expense categories for current month
    prisma.expense.groupBy({
      by: ['category'],
      where: {
        businessId,
        expenseDate: monthFilter,
      },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 5,
    }),
    // Existing calculated monthly tax report
    prisma.monthlyTaxReport.findUnique({
      where: {
        businessId_taxMonth: {
          businessId,
          taxMonth: currentMonthStart,
        },
      },
    }),
    // Invoices pending payment or overdue
    prisma.invoice.findMany({
      where: {
        businessId,
        status: { in: ['sent', 'overdue'] },
      },
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        status: true,
        dueDate: true,
      },
    }),
    // Last 6 months trend
    prisma.monthlyTaxReport.findMany({
      where: { businessId },
      orderBy: { taxMonth: 'desc' },
      take: 6,
    }),
    // Active un-sent reminders/alerts
    prisma.reminder.findMany({
      where: {
        businessId,
        isSent: false,
      },
      select: {
        reminderType: true,
        message: true,
      },
      take: 5,
    }),
  ]);

  const totalSales = toNumber(salesAgg._sum.amount);
  const totalExpenses = toNumber(expenseAgg._sum.amount);
  const grossProfit = totalSales - totalExpenses;
  const profitMargin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;
  const isOperatingLoss = grossProfit < 0;
  const taxRate = currentReport ? toNumber(currentReport.taxRate) : 7.5;
  const taxPayable = isOperatingLoss ? 0 : grossProfit * (taxRate / 100);

  // Top expense drivers with % share
  const topExpenseDrivers = categoryGroups.map((g) => {
    const amount = toNumber(g._sum.amount);
    const sharePercent = totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0;
    return {
      category: g.category.replace(/_/g, ' '),
      amount,
      sharePercent: Number(sharePercent.toFixed(1)),
    };
  });

  // Invoicing breakdown
  let overdueCount = 0;
  let overdueAmount = 0;
  let unpaidSentCount = 0;
  let unpaidSentAmount = 0;

  for (const inv of unpaidInvoices) {
    const invTotal = toNumber(inv.total);
    const isPastDue = inv.status === 'overdue' || (inv.dueDate && new Date(inv.dueDate) < now);
    if (isPastDue) {
      overdueCount++;
      overdueAmount += invTotal;
    } else {
      unpaidSentCount++;
      unpaidSentAmount += invTotal;
    }
  }

  // Trend history (oldest to newest for trajectory)
  const recentTrends = recentReports
    .slice()
    .reverse()
    .map((r) => {
      const monthStr = new Date(r.taxMonth).toLocaleDateString('en-GB', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
      return {
        month: monthStr,
        sales: toNumber(r.totalSales),
        expenses: toNumber(r.totalExpenses),
        grossProfit: toNumber(r.grossProfit),
        marginPercent: Number(toNumber(r.profitMargin).toFixed(1)),
        taxPayable: toNumber(r.taxPayable),
        isPaid: r.paymentStatus === 'completed' || r.isLocked,
      };
    });

  // Diagnostics & Compliance Alerts
  const complianceAlerts: string[] = [];

  // FIRS statutory deadline: 21st of following month
  const nextMonthYear = now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const nextMonthIndex = (now.getUTCMonth() + 1) % 12;
  const deadlineDate = new Date(Date.UTC(nextMonthYear, nextMonthIndex, 21));
  const deadlineStr = deadlineDate.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  complianceAlerts.push(
    `FIRS Tax Remittance Deadline: Tax for ${now.toLocaleString('en-GB', { month: 'long' })} is due on or before ${deadlineStr}.`
  );

  const defaultMargin = business.defaultProfitMargin ? toNumber(business.defaultProfitMargin) : 20.0;
  if (totalSales > 0 && Math.abs(profitMargin - defaultMargin) > 15) {
    if (profitMargin < defaultMargin) {
      complianceAlerts.push(
        `Profit Margin Warning: Current margin (${profitMargin.toFixed(1)}%) is significantly below target (${defaultMargin}%). Possible causes: high operating costs or uncaptured sales.`
      );
    } else {
      complianceAlerts.push(
        `Margin Deviation Alert: Current margin (${profitMargin.toFixed(1)}%) is unusually high (>15% above target). Nudge: ensure all deductible business expenses are recorded to avoid overpaying tax.`
      );
    }
  }

  if (totalSales > 0 && totalExpenses === 0) {
    complianceAlerts.push(
      'No deductible expenses recorded for this month. Recording legitimate business expenses reduces taxable gross profit under FIRS regulations.'
    );
  }

  if (isOperatingLoss) {
    complianceAlerts.push(
      `Operating Loss Alert: Expenses (₦${totalExpenses.toLocaleString()}) exceed Sales (₦${totalSales.toLocaleString()}). No tax is currently payable (₦0.00).`
    );
  }

  if (overdueAmount > 0) {
    complianceAlerts.push(
      `Uncollected Revenue: ₦${overdueAmount.toLocaleString()} is overdue across ${overdueCount} unpaid invoice(s).`
    );
  }

  for (const rem of activeReminders) {
    if (rem.message && !complianceAlerts.some((a) => a.includes(rem.message!))) {
      complianceAlerts.push(rem.message);
    }
  }

  const currentMonthName = now.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const context: BusinessFinancialContext = {
    business: {
      id: business.id,
      name: business.businessName,
      industry: business.businessType || null,
      currency: 'NGN',
      targetProfitMarginPercent: defaultMargin,
      taxId: business.taxId,
    },
    currentMonth: {
      periodName: currentMonthName,
      totalSales,
      totalExpenses,
      grossProfit,
      profitMarginPercent: Number(profitMargin.toFixed(1)),
      isOperatingLoss,
      taxPayable: Number(taxPayable.toFixed(2)),
      taxRatePercent: taxRate,
      isFinalized: currentReport?.isFinalized ?? false,
      paymentStatus: currentReport?.paymentStatus ?? 'pending',
    },
    topExpenseDrivers,
    invoicingHealth: {
      overdueInvoicesCount: overdueCount,
      overdueAmount,
      unpaidSentCount,
      unpaidSentAmount,
    },
    recentTrends,
    complianceAlerts,
  };

  // Convert context into a compact, bullet-pointed financial brief for LLM grounding
  const summaryText = `
=== BUSINESS FINANCIAL PROFILE ===
Business Name: ${business.businessName}
Industry: ${business.businessType || 'SME / Commerce'}
Base Currency: NGN (₦)
Target Profit Margin: ${defaultMargin}%

--- CURRENT MONTH (${currentMonthName}) ---
Total Sales Revenue: ₦${totalSales.toLocaleString()}
Total Deductible Expenses: ₦${totalExpenses.toLocaleString()}
Gross Profit (Sales - Expenses): ₦${grossProfit.toLocaleString()}
Profit Margin: ${profitMargin.toFixed(1)}% (Target: ${defaultMargin}%)
Tax Rate: ${taxRate}% (FIRS Standard: 7.5% of Gross Profit)
Estimated Tax Payable: ₦${taxPayable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Report Status: ${currentReport?.isFinalized ? 'Finalized' : 'Draft / Live In-Progress'}
Payment Status: ${currentReport?.paymentStatus ?? 'Pending'}

--- EXPENSE BREAKDOWN (TOP SPENDING AREAS) ---
${topExpenseDrivers.length > 0 ? topExpenseDrivers.map((d) => `• ${d.category}: ₦${d.amount.toLocaleString()} (${d.sharePercent}% of expenses)`).join('\n') : '• No expenses recorded this month yet.'}

--- INVOICES & RECEIVABLES ---
Overdue Unpaid Invoices: ${overdueCount} (₦${overdueAmount.toLocaleString()} tied up)
Pending Unpaid Invoices: ${unpaidSentCount} (₦${unpaidSentAmount.toLocaleString()})

--- 6-MONTH TREND TRAJECTORY ---
${recentTrends.length > 0 ? recentTrends.map((t) => `• ${t.month}: Sales ₦${t.sales.toLocaleString()} | Expenses ₦${t.expenses.toLocaleString()} | Margin ${t.marginPercent}% | Tax ₦${t.taxPayable.toLocaleString()} [${t.isPaid ? 'Paid' : 'Unpaid'}]`).join('\n') : '• No historical monthly reports yet.'}

--- ACTIVE COMPLIANCE & FINANCIAL ALERTS ---
${complianceAlerts.map((a) => `• ${a}`).join('\n')}
`.trim();

  return { context, summaryText };
}
