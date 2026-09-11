import { Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  paginationSchema,
  userSearchSchema,
  toggleStatusSchema,
  verifyEmailSchema,
  auditLogFilterSchema,
  manualSettleWithdrawalSchema,
  updateFeeConfigSchema,
  treasuryAnalyticsFilterSchema,
} from '@/validators/admin.validator';
import * as adminService from '@/services/admin.service';
import * as settlementService from '@/services/settlement.service';
import { PlatformConfigService } from '@/services/platform-config.service';

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

export const grantPayoutChangePermission = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const result = await adminService.grantPayoutChangePermission(
      req.params.businessId,
      req.user!.userId
    );

    res.status(200).json({
      success: true,
      data: result,
      message: 'One-time payout change permission granted. Expires in 24 hours.',
    });
  }
);

export const revokePayoutChangePermission = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const result = await adminService.revokePayoutChangePermission(
      req.params.businessId,
      req.user!.userId
    );

    res.status(200).json({
      success: true,
      data: result,
      message: 'Payout change permission revoked successfully.',
    });
  }
);


// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Withdrawal Request Management (NEW-7 v2)
// ═══════════════════════════════════════════════════════════════════════════

export const listWithdrawalRequests = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const status = req.query.status as 'pending' | 'processing' | 'completed' | 'failed' | undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;

    const result = await settlementService.adminListWithdrawalRequests({
      status,
      search,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      data: result.items,
      items: result.items,
      pagination: result.pagination,
    });
  }
);

export const approveWithdrawalRequest = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const result = await settlementService.adminApproveWithdrawal(
      req.user!.userId,
      req.params.id
    );

    res.status(200).json({
      success: true,
      data: result,
      message: 'Withdrawal request approved and transfer initiated.',
    });
  }
);

export const rejectWithdrawalRequest = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Rejection reason is required (minimum 3 characters)',
        },
      });
    }

    const result = await settlementService.adminRejectWithdrawal(
      req.user!.userId,
      req.params.id,
      reason.trim()
    );

    res.status(200).json({
      success: true,
      data: result,
      message: 'Withdrawal request rejected.',
    });
  }
);

export const requeryWithdrawalRequest = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const result = await settlementService.adminRequeryWithdrawal(
      req.user!.userId,
      req.params.id
    );

    res.status(200).json({
      success: true,
      data: result,
      message: result.message,
    });
  }
);

export const manualSettleWithdrawalRequest = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const input = manualSettleWithdrawalSchema.parse(req.body);
    const result = await settlementService.adminManualSettleWithdrawal(
      req.user!.userId,
      req.params.id,
      input
    );

    res.status(200).json({
      success: true,
      data: result,
      message: 'Withdrawal marked as settled via manual bank transfer.',
    });
  }
);

export const toggleBusinessAutoPayout = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { businessId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '"enabled" boolean field is required',
        },
      });
    }

    const result = await settlementService.adminToggleAutoPayout(
      req.user!.userId,
      businessId,
      enabled
    );

    res.status(200).json({
      success: true,
      data: result,
      message: `Auto-payout ${enabled ? 'enabled' : 'disabled'} for business.`,
    });
  }
);

export const getTreasuryAnalytics = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const filters = treasuryAnalyticsFilterSchema.parse(req.query);
    const result = await adminService.getTreasuryAnalytics(filters);

    res.status(200).json({
      success: true,
      data: result,
    });
  }
);

export const getTreasuryTransactionDetail = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const type = req.query.type as 'inflow' | 'outflow' | undefined;
    const detail = await adminService.getTreasuryTransactionDetail(id, type);

    res.status(200).json({
      success: true,
      data: detail,
    });
  }
);

export const getFeeConfig = asyncHandler(
  async (_req: AuthenticatedRequest, res: Response) => {
    const config = await PlatformConfigService.getFeeConfig();

    res.status(200).json({
      success: true,
      data: config,
    });
  }
);

export const updateFeeConfig = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const params = updateFeeConfigSchema.parse(req.body);
    const updated = await PlatformConfigService.updateFeeConfig(
      params,
      req.user!.userId,
      { ip: req.ip, userAgent: req.headers['user-agent'] }
    );

    res.status(200).json({
      success: true,
      data: updated,
      message: 'Global platform fee configuration updated successfully.',
    });
  }
);

