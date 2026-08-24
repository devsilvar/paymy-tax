import prisma, { TxClient } from '@/lib/prisma';
import logger from '@/lib/logger';
import { AppError } from '@/middleware/errorHandler';
import { CreateBusinessInput, UpdateBusinessInput } from '@/validators/business.validator';
import { logAudit } from '@/lib/audit';
import { invalidateOwnershipCache } from '@/lib/ownership';
import {
  uploadLogoToCloudinary,
  deleteLogoFromCloudinary,
  ALLOWED_LOGO_MIMES,
  MAX_LOGO_BYTES,
} from '@/lib/cloudinary';


async function generateMerchantId(db: TxClient | typeof prisma): Promise<string> {
  const PREFIX = 'PMTW';
  const PAD_LENGTH = 7;

  const lastBusiness = await db.business.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { merchantId: true },
  });

  let nextNum = 1;
  if (lastBusiness?.merchantId) {
    const numPart = lastBusiness.merchantId.replace(PREFIX, '');
    nextNum = parseInt(numPart, 10) + 1;
  }

  return `${PREFIX}${String(nextNum).padStart(PAD_LENGTH, '0')}`;
}

export async function createBusiness(userId: string, input: CreateBusinessInput, tx?: TxClient) {
  const db = tx ?? prisma;

  const merchantId = await generateMerchantId(db);

  const business = await db.business.create({
    data: {
      ...input,
      userId,
      merchantId,
    },
  });

  logAudit({
    userId,
    businessId: business.id,
    action: 'business.created',
    resourceType: 'business',
    resourceId: business.id,
    newData: { businessName: input.businessName, ownerName: input.ownerName },
  }, tx);

  logger.info('Business created', { businessId: business.id, userId });

  return business;
}

export async function listBusinesses(userId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const [businesses, total] = await Promise.all([
    prisma.business.findMany({
      where: { userId },
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.business.count({ where: { userId } }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: businesses,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

export async function getBusinessById(userId: string, businessId: string) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  return business;
}

export async function updateBusiness(
  userId: string,
  businessId: string,
  input: UpdateBusinessInput,
  tx?: TxClient
) {
  const db = tx ?? prisma;

  const business = await db.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  const updated = await db.business.update({
    where: { id: businessId },
    data: input,
  });

  logAudit({
    userId,
    businessId,
    action: 'business.updated',
    resourceType: 'business',
    resourceId: businessId,
    oldData: { businessName: business.businessName },
    newData: input as Record<string, any>,
  }, tx);

  // Invalidate ownership cache after update
  invalidateOwnershipCache(businessId, userId);

  logger.info('Business updated', { businessId, userId });

  return updated;
}

export async function deleteBusiness(userId: string, businessId: string, tx?: TxClient) {
  const db = tx ?? prisma;

  const business = await db.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  }

  if (business.userId !== userId) {
    throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  }

  // Cascade delete logo from Cloudinary if present
  if (business.logoPublicId) {
    await deleteLogoFromCloudinary(business.logoPublicId).catch(() => {});
  }

  await db.business.delete({
    where: { id: businessId },
  });

  logAudit({
    userId,
    businessId,
    action: 'business.deleted',
    resourceType: 'business',
    resourceId: businessId,
    oldData: { businessName: business.businessName },
  }, tx);

  // Invalidate ownership cache after deletion
  invalidateOwnershipCache(businessId, userId);

  logger.info('Business deleted', { businessId, userId });

  return { message: 'Business deleted successfully' };
}

export async function uploadLogo(
  userId: string,
  businessId: string,
  file: { buffer: Buffer; mimetype: string; size: number },
) {
  if (!ALLOWED_LOGO_MIMES.has(file.mimetype)) {
    throw new AppError(400, 'Only JPEG, PNG, WebP or SVG images are accepted.', 'LOGO_BAD_TYPE');
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new AppError(400, 'Logo must be 2 MB or smaller.', 'LOGO_TOO_LARGE');
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  if (business.userId !== userId) throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');

  const { url, publicId } = await uploadLogoToCloudinary(
    businessId,
    file.buffer,
    file.mimetype,
    business.logoPublicId,
  );

  const updated = await prisma.business.update({
    where: { id: businessId },
    data: { logoUrl: url, logoPublicId: publicId },
  });

  logAudit({
    userId,
    businessId,
    action: 'business.logo_uploaded',
    resourceType: 'business',
    resourceId: businessId,
    newData: { logoUrl: url },
  });

  invalidateOwnershipCache(businessId, userId);
  logger.info('Business logo uploaded', { businessId, userId });

  return updated;
}

export async function removeLogo(userId: string, businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new AppError(404, 'Business not found', 'BUSINESS_NOT_FOUND');
  if (business.userId !== userId) throw new AppError(403, 'You do not have access to this business', 'FORBIDDEN');
  if (!business.logoUrl) throw new AppError(404, 'No logo to remove', 'LOGO_NOT_FOUND');

  if (business.logoPublicId) {
    await deleteLogoFromCloudinary(business.logoPublicId);
  }

  const updated = await prisma.business.update({
    where: { id: businessId },
    data: { logoUrl: null, logoPublicId: null },
  });

  logAudit({
    userId,
    businessId,
    action: 'business.logo_deleted',
    resourceType: 'business',
    resourceId: businessId,
  });

  invalidateOwnershipCache(businessId, userId);
  logger.info('Business logo removed', { businessId, userId });

  return updated;
}

