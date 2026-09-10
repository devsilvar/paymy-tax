import prisma from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { SearchQueryInput } from '@/validators/search.validator';

// Scope: Invoices + Customers only.
// Why these two: invoices are the most-searched record by SMEs (number, customer name,
// "did I send Chidi yet"), and customers are the natural pivot — find a customer, see
// their invoices. Sales/expenses are reachable via filters on their own pages and would
// dilute the palette without adding much value.
export interface SearchResults {
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    customerName: string;
    total: number;
    status: string;
    issueDate: string;
    dueDate: string;
  }>;
  customers: Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    invoiceCount: number;
  }>;
  totalCount: number;
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Cross-domain search for the command palette.
 *
 * Two parallel queries scoped to a single business. Each is bounded by `limit` so a busy
 * business with 50k invoices can't bloat the response. Uses Prisma `mode: 'insensitive'`
 * contains-search — fine at v1 scale; will need a tsvector / pg_trgm index when row counts
 * cross ~100k per business.
 *
 * Ownership is verified once up front; otherwise each query would have to join Business,
 * adding plan cost.
 */
export async function searchAcrossBusiness(
  userId: string,
  businessId: string,
  input: SearchQueryInput
): Promise<SearchResults> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, userId: true },
  });
  if (!business) throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  const { q, limit } = input;
  const contains = { contains: q, mode: 'insensitive' as const };

  const [invoices, customers] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        businessId,
        OR: [
          { invoiceNumber: contains },
          { customerName: contains },
          { customerEmail: contains },
        ],
      },
      orderBy: { issueDate: 'desc' },
      take: limit,
      select: {
        id: true,
        invoiceNumber: true,
        customerName: true,
        total: true,
        status: true,
        issueDate: true,
        dueDate: true,
      },
    }),

    prisma.customer.findMany({
      where: {
        businessId,
        OR: [{ name: contains }, { email: contains }, { phone: contains }],
      },
      orderBy: { name: 'asc' },
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        _count: { select: { invoices: true } },
      },
    }),
  ]);

  const result: SearchResults = {
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      customerName: i.customerName,
      total: num(i.total),
      status: i.status,
      issueDate: i.issueDate.toISOString(),
      dueDate: i.dueDate.toISOString(),
    })),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      invoiceCount: c._count.invoices,
    })),
    totalCount: 0,
  };
  result.totalCount = result.invoices.length + result.customers.length;

  return result;
}
