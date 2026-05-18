import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import { searchQuerySchema } from '@/validators/search.validator';
import * as searchService from '@/services/search.service';

export const search = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = searchQuerySchema.parse(req.query);
  const data = await searchService.searchAcrossBusiness(
    req.user!.userId,
    req.params.businessId,
    query
  );

  res.status(200).json({
    success: true,
    data,
  });
});
