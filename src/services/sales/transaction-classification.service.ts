import prisma from '@/lib/prisma';
import logger from '@/lib/logger';

/**
 * Get all active transaction classifications
 */
export async function getClassifications() {
  try {
    return await prisma.transactionClassification.findMany({
      where: { isActive: true },
      orderBy: [
        { category: 'asc' },
        { name: 'asc' },
      ],
    });
  } catch (error: any) {
    // Table doesn't exist yet - migration not run
    if (error.code === 'P2021' || error.message?.includes('transactionClassification')) {
      logger.warn('TransactionClassification table not found. Run migration: npx prisma migrate dev');
      return [];
    }
    throw error;
  }
}

/**
 * Get classification by ID
 */
export async function getClassificationById(id: string) {
  return prisma.transactionClassification.findUnique({
    where: { id },
  });
}

/**
 * Get classification by name
 */
export async function getClassificationByName(name: string) {
  return prisma.transactionClassification.findUnique({
    where: { name },
  });
}

/**
 * Get classifications by category
 */
export async function getClassificationsByCategory(category: string) {
  return prisma.transactionClassification.findMany({
    where: {
      category: category as any,
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });
}

/**
 * Get revenue classifications (taxable sales)
 */
export async function getRevenueClassifications() {
  return prisma.transactionClassification.findMany({
    where: {
      isRevenue: true,
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });
}

/**
 * Check if classification is revenue (should create sale)
 */
export async function isRevenueClassification(classificationId: string): Promise<boolean> {
  const classification = await prisma.transactionClassification.findUnique({
    where: { id: classificationId },
    select: { isRevenue: true },
  });
  
  return classification?.isRevenue ?? false;
}

/**
 * Check if classification is taxable
 */
export async function isTaxableClassification(classificationId: string): Promise<boolean> {
  const classification = await prisma.transactionClassification.findUnique({
    where: { id: classificationId },
    select: { taxTreatment: true },
  });
  
  return classification?.taxTreatment === 'taxable';
}

logger.info('Transaction classification service initialized');
