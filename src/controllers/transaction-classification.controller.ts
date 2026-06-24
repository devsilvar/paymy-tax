import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import * as classificationService from '@/services/transaction-classification.service';

/**
 * Get all transaction classifications
 */
export const getClassifications = asyncHandler(async (req: Request, res: Response) => {
  const classifications = await classificationService.getClassifications();
  
  res.json({
    success: true,
    data: classifications,
  });
});

/**
 * Get classifications by category
 */
export const getClassificationsByCategory = asyncHandler(async (req: Request, res: Response) => {
  const { category } = req.params;
  
  const classifications = await classificationService.getClassificationsByCategory(String(category));
  
  res.json({
    success: true,
    data: classifications,
  });
});

/**
 * Get revenue classifications
 */
export const getRevenueClassifications = asyncHandler(async (req: Request, res: Response) => {
  const classifications = await classificationService.getRevenueClassifications();
  
  res.json({
    success: true,
    data: classifications,
  });
});
