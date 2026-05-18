import { z } from 'zod';

export const createBusinessSchema = z.object({
  businessName: z.string().min(2, 'Business name must be at least 2 characters').max(200).trim(),
  ownerName: z.string().min(2, 'Owner name must be at least 2 characters').max(200).trim(),
  taxId: z.string().min(1, 'Tax ID is required').max(50).trim().optional(),
  businessType: z.string().min(1, 'Business type is required').max(100).trim(),
  address: z.string().max(500).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  defaultProfitMargin: z.number().min(0).max(100).optional(),
  taxReminderDay: z.number().int().min(1).max(28).optional(),
});

export const updateBusinessSchema = z.object({
  businessName: z.string().min(2).max(200).trim().optional(),
  ownerName: z.string().min(2).max(200).trim().optional(),
  taxId: z.string().max(50).trim().optional(),
  businessType: z.string().max(100).trim().optional(),
  address: z.string().max(500).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  defaultProfitMargin: z.number().min(0).max(100).optional(),
  taxReminderDay: z.number().int().min(1).max(28).optional(),
});

export const businessQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
export type BusinessQueryInput = z.infer<typeof businessQuerySchema>;
