import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  paginationSchema,
  userSearchSchema,
  toggleStatusSchema,
  verifyEmailSchema,
  auditLogFilterSchema,
} from '@/validators/admin.validator';
import * as adminService from '@/services/admin.service';

export const getDashboard = asyncHandler(
  async (_req: AuthenticatedRequest, res: Response) => {
    const stats = await adminService.getDashboardStats();

    res.status(200).json({
      success: true,
      data: stats,
    });
  }
);

export const listUsers = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { page, limit, search } = userSearchSchema.parse(req.query);
    const result = await adminService.listUsers(page, limit, search);

    res.status(200).json({
      success: true,
      ...result,
    });
  }
);

export const getUserDetail = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const user = await adminService.getUserDetail(req.params.id);

    res.status(200).json({
      success: true,
      data: user,
    });
  }
);

export const toggleUserStatus = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { isActive } = toggleStatusSchema.parse(req.body);
    const result = await adminService.toggleUserStatus(req.params.id, isActive, req.user!.userId);

    res.status(200).json({
      success: true,
      data: result,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
    });
  }
);

export const toggleEmailVerification = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { isVerified } = verifyEmailSchema.parse(req.body);
    
    const result = isVerified
      ? await adminService.verifyUserEmail(req.params.id, req.user!.userId)
      : await adminService.unverifyUserEmail(req.params.id, req.user!.userId);

    res.status(200).json({
      success: true,
      data: result,
      message: `User email ${isVerified ? 'verified' : 'unverified'} successfully`,
    });
  }
);

export const listBusinesses = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { page, limit } = paginationSchema.parse(req.query);
    const result = await adminService.listAllBusinesses(page, limit);

    res.status(200).json({
      success: true,
      ...result,
    });
  }
);

export const listAuditLogs = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { page, limit, userId, action } = auditLogFilterSchema.parse(req.query);
    const result = await adminService.listAuditLogs(page, limit, { userId, action });

    res.status(200).json({
      success: true,
      ...result,
    });
  }
);
