import prisma from '@/lib/prisma';
import { toNumber } from '@/shared/helpers';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';

export interface PlatformFeeConfigData {
  withdrawalFeePct: number;
  withdrawalFeeCap: number;
  minWithdrawalAmount: number;
  autoSweepEnabled: boolean;
  autoSweepThreshold: number;
  updatedAt?: Date;
  updatedBy?: string | null;
}

export const DEFAULT_FEE_CONFIG: PlatformFeeConfigData = {
  withdrawalFeePct: 1.0,
  withdrawalFeeCap: 300.0,
  minWithdrawalAmount: 1000.0,
  autoSweepEnabled: true,
  autoSweepThreshold: 1000.0,
};

let cachedFeeConfig: PlatformFeeConfigData | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds (balances DB query reduction with multi-instance freshness)

export class PlatformConfigService {
  /**
   * Retrieves the active platform fee configuration.
   * Utilizes in-memory caching with 30-second TTL and graceful fallback to defaults.
   */
  static async getFeeConfig(): Promise<PlatformFeeConfigData> {
    const now = Date.now();
    if (cachedFeeConfig && now < cacheExpiry) {
      return cachedFeeConfig;
    }

    try {
      const configRecord = await prisma.platformFeeConfig.findUnique({
        where: { id: 'default' },
      });

      if (configRecord) {
        cachedFeeConfig = {
          withdrawalFeePct: toNumber(configRecord.withdrawalFeePct),
          withdrawalFeeCap: toNumber(configRecord.withdrawalFeeCap),
          minWithdrawalAmount: toNumber(configRecord.minWithdrawalAmount),
          autoSweepEnabled: configRecord.autoSweepEnabled ?? true,
          autoSweepThreshold: toNumber(configRecord.autoSweepThreshold ?? 1000),
          updatedAt: configRecord.updatedAt,
          updatedBy: configRecord.updatedBy,
        };
        cacheExpiry = now + CACHE_TTL_MS;
        return cachedFeeConfig;
      }
    } catch (err: any) {
      logger.warn(`Failed to fetch platform fee config from database, using fallback: ${err.message}`);
    }

    // Fallback if not found or DB query errors
    cachedFeeConfig = { ...DEFAULT_FEE_CONFIG, updatedAt: new Date() };
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedFeeConfig;
  }

  /**
   * Updates the global platform fee configuration and purges memory cache.
   */
  static async updateFeeConfig(
    params: {
      withdrawalFeePct: number;
      withdrawalFeeCap: number;
      minWithdrawalAmount: number;
      autoSweepEnabled?: boolean;
      autoSweepThreshold?: number;
    },
    adminUserId: string,
    reqMeta?: { ip?: string; userAgent?: string }
  ): Promise<PlatformFeeConfigData> {
    const previousConfig = await this.getFeeConfig();

    const autoSweepEnabled =
      params.autoSweepEnabled !== undefined ? params.autoSweepEnabled : previousConfig.autoSweepEnabled;
    const autoSweepThreshold =
      params.autoSweepThreshold !== undefined ? params.autoSweepThreshold : previousConfig.autoSweepThreshold;

    const updated = await prisma.platformFeeConfig.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        withdrawalFeePct: params.withdrawalFeePct,
        withdrawalFeeCap: params.withdrawalFeeCap,
        minWithdrawalAmount: params.minWithdrawalAmount,
        autoSweepEnabled,
        autoSweepThreshold,
        updatedBy: adminUserId,
      },
      update: {
        withdrawalFeePct: params.withdrawalFeePct,
        withdrawalFeeCap: params.withdrawalFeeCap,
        minWithdrawalAmount: params.minWithdrawalAmount,
        autoSweepEnabled,
        autoSweepThreshold,
        updatedBy: adminUserId,
      },
    });

    const result: PlatformFeeConfigData = {
      withdrawalFeePct: toNumber(updated.withdrawalFeePct),
      withdrawalFeeCap: toNumber(updated.withdrawalFeeCap),
      minWithdrawalAmount: toNumber(updated.minWithdrawalAmount),
      autoSweepEnabled: updated.autoSweepEnabled,
      autoSweepThreshold: toNumber(updated.autoSweepThreshold),
      updatedAt: updated.updatedAt,
      updatedBy: updated.updatedBy,
    };

    // Invalidate and refresh cache
    cachedFeeConfig = result;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    // Audit log
    await logAudit({
      userId: adminUserId,
      action: 'admin.fee_config_updated',
      resourceType: 'PlatformFeeConfig',
      resourceId: 'default',
      oldData: previousConfig as any,
      newData: result as any,
      ipAddress: reqMeta?.ip,
      userAgent: reqMeta?.userAgent,
    });

    return result;
  }

  /**
   * Toggles the global auto-sweep engine on or off and updates audit log.
   */
  static async toggleAutoSweep(
    enabled: boolean,
    adminUserId: string,
    reqMeta?: { ip?: string; userAgent?: string }
  ): Promise<PlatformFeeConfigData> {
    const previousConfig = await this.getFeeConfig();

    const updated = await prisma.platformFeeConfig.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        withdrawalFeePct: previousConfig.withdrawalFeePct,
        withdrawalFeeCap: previousConfig.withdrawalFeeCap,
        minWithdrawalAmount: previousConfig.minWithdrawalAmount,
        autoSweepEnabled: enabled,
        autoSweepThreshold: previousConfig.autoSweepThreshold,
        updatedBy: adminUserId,
      },
      update: {
        autoSweepEnabled: enabled,
        updatedBy: adminUserId,
      },
    });

    const result: PlatformFeeConfigData = {
      withdrawalFeePct: toNumber(updated.withdrawalFeePct),
      withdrawalFeeCap: toNumber(updated.withdrawalFeeCap),
      minWithdrawalAmount: toNumber(updated.minWithdrawalAmount),
      autoSweepEnabled: updated.autoSweepEnabled,
      autoSweepThreshold: toNumber(updated.autoSweepThreshold),
      updatedAt: updated.updatedAt,
      updatedBy: updated.updatedBy,
    };

    cachedFeeConfig = result;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    await logAudit({
      userId: adminUserId,
      action: enabled ? 'admin.auto_sweep_enabled' : 'admin.auto_sweep_disabled',
      resourceType: 'PlatformFeeConfig',
      resourceId: 'default',
      oldData: { autoSweepEnabled: previousConfig.autoSweepEnabled },
      newData: { autoSweepEnabled: enabled },
      ipAddress: reqMeta?.ip,
      userAgent: reqMeta?.userAgent,
    });

    logger.info(`[ADMIN_CONFIG] Auto-sweep administratively toggled to ${enabled ? 'ON' : 'OFF'} by admin ${adminUserId}`);

    return result;
  }

  /**
   * Returns current live auto-sweep status and threshold.
   */
  static async isAutoSweepEnabled(): Promise<{ enabled: boolean; thresholdNaira: number }> {
    const config = await this.getFeeConfig();
    return {
      enabled: config.autoSweepEnabled !== undefined ? config.autoSweepEnabled : true,
      thresholdNaira: config.autoSweepThreshold || 1000,
    };
  }

  /**
   * Clears the active fee cache.
   */
  static invalidateFeeConfigCache(): void {
    cachedFeeConfig = null;
    cacheExpiry = 0;
  }
}
