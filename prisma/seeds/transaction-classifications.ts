import { PrismaClient, TransactionCategory, TaxTreatment } from '@prisma/client';

const prisma = new PrismaClient();

export const DEFAULT_CLASSIFICATIONS = [
  // Taxable Revenue
  {
    name: 'Product Sale',
    category: TransactionCategory.revenue,
    taxTreatment: TaxTreatment.taxable,
    isRevenue: true,
    isActive: true,
    description: 'Money from selling goods or products',
  },
  {
    name: 'Service Revenue',
    category: TransactionCategory.revenue,
    taxTreatment: TaxTreatment.taxable,
    isRevenue: true,
    isActive: true,
    description: 'Money from providing services',
  },
  
  // Non-Taxable Income
  {
    name: 'Capital Injection',
    category: TransactionCategory.capital,
    taxTreatment: TaxTreatment.non_taxable,
    isRevenue: false,
    isActive: true,
    description: 'Your own money you put into the business',
  },
  {
    name: 'Loan Received',
    category: TransactionCategory.loan,
    taxTreatment: TaxTreatment.non_taxable,
    isRevenue: false,
    isActive: true,
    description: 'Money borrowed that must be repaid',
  },
  {
    name: 'Gift Received',
    category: TransactionCategory.gift,
    taxTreatment: TaxTreatment.non_taxable,
    isRevenue: false,
    isActive: true,
    description: 'Money given to you as a gift',
  },
  {
    name: 'Grant Received',
    category: TransactionCategory.grant,
    taxTreatment: TaxTreatment.non_taxable,
    isRevenue: false,
    isActive: true,
    description: 'Free money from government or organization',
  },
  {
    name: 'Transfer Between Accounts',
    category: TransactionCategory.transfer,
    taxTreatment: TaxTreatment.non_taxable,
    isRevenue: false,
    isActive: true,
    description: 'Moving money between your own accounts',
  },
  {
    name: 'Refund Received',
    category: TransactionCategory.refund,
    taxTreatment: TaxTreatment.non_taxable,
    isRevenue: false,
    isActive: true,
    description: 'Money returned from a previous payment',
  },
  
  // Other
  {
    name: 'Other',
    category: TransactionCategory.other,
    taxTreatment: TaxTreatment.review_required,
    isRevenue: false,
    isActive: true,
    description: 'Other types of income not listed above',
  },
];

export async function seedTransactionClassifications() {
  console.log('🌱 Seeding transaction classifications...');
  
  // Delete old classifications first
  await prisma.transactionClassification.deleteMany();
  
  for (const classification of DEFAULT_CLASSIFICATIONS) {
    await prisma.transactionClassification.create({
      data: classification,
    });
  }
  
  console.log(`✅ Seeded ${DEFAULT_CLASSIFICATIONS.length} simple transaction classifications`);
}
