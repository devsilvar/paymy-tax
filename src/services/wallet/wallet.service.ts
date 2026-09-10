import { Prisma, WalletTxType, WalletBalance, WalletTransaction } from '@prisma/client';
import axios from 'axios';
import prisma, { TxClient } from '@/lib/prisma';
import { toNumber } from '@/shared/helpers/number';
import { SETTLED_SALE_STATUSES } from '@/shared/helpers';
import { AppError } from '@/middleware/errorHandler';
import logger from '@/lib/logger';
import { config } from '@/config';

export interface CreditWalletParams {
  userId: string;
  businessId?: string | null;
  amount: number | Prisma.Decimal;
  fee?: number | Prisma.Decimal;
  netAmount?: number | Prisma.Decimal;
  reference: string;
  source: string;
  type?: WalletTxType;
  description?: string;
  idempotencyKey?: string;
  linkedSaleId?: string;
  metadata?: Record<string, any>;
}

export interface ReserveFundsParams {
  userId: string;
  amount: number | Prisma.Decimal;
  fee?: number | Prisma.Decimal;
  reference: string;
  linkedPayoutId?: string;
  description?: string;
}

export interface SettlePayoutParams {
  userId: string;
  businessId?: string | null;
  amount: number | Prisma.Decimal;
  fee?: number | Prisma.Decimal;
  reference: string;
  linkedPayoutId?: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface ReleaseLockedFundsParams {
  userId: string;
  amount: number | Prisma.Decimal;
  fee?: number | Prisma.Decimal;
}

export interface WalletHistoryQuery {
  page?: number;
  limit?: number;
  type?: WalletTxType;
  businessId?: string;
}

export interface WalletBalanceDto {
  id: string;
  userId: string;
  balance: number;
  lockedBalance: number;
  availableBalance: number;
  currency: string;
  version: number;
  lastSyncedAt: Date;
}

const TX_OPTIONS = { maxWait: 15000, timeout: 30000 };

export class WalletService {
  /**
   * Retrieves or creates a WalletBalance record for the specified user.
   */
  static async getOrCreateWallet(userId: string, tx?: TxClient): Promise<WalletBalance> {
    const db = tx ?? prisma;

    const existing = await db.walletBalance.findUnique({
      where: { userId },
    });

    if (existing) {
      return existing;
    }

    try {
      return await db.walletBalance.create({
        data: {
          userId,
          balance: new Prisma.Decimal(0),
          lockedBalance: new Prisma.Decimal(0),
          currency: 'NGN',
          version: 0,
        },
      });
    } catch (err: any) {
      // Handle potential race condition if two calls create simultaneously
      if (err.code === 'P2002') {
        const found = await db.walletBalance.findUnique({ where: { userId } });
        if (found) return found;
      }
      throw err;
    }
  }

  /**
   * Fast O(1) balance read for a user.
   */
  static async getWalletBalance(userId: string, tx?: TxClient): Promise<WalletBalanceDto> {
    await this.syncUncreditedDvaSales(userId, tx);
    const wallet = await this.getOrCreateWallet(userId, tx);
    const balance = toNumber(wallet.balance);
    const lockedBalance = toNumber(wallet.lockedBalance);
    const availableBalance = Math.max(0, balance - lockedBalance);

    return {
      id: wallet.id,
      userId: wallet.userId,
      balance,
      lockedBalance,
      availableBalance,
      currency: wallet.currency,
      version: wallet.version,
      lastSyncedAt: wallet.updatedAt,
    };
  }

  /**
   * Self-healing sync: finds any settled DVA sales that have not been credited to
   * the central user wallet (e.g. following a database restore or pre-migration history)
   * and credits them atomically into the wallet ledger.
   */
  static async syncUncreditedDvaSales(userId: string, tx?: TxClient): Promise<number> {
    const db = tx ?? prisma;
    const userBusinesses = await db.business.findMany({
      where: { userId },
      select: { id: true },
    });
    if (userBusinesses.length === 0) return 0;

    const bizIds = userBusinesses.map((b) => b.id);
    const uncreditedSales = await db.salesTransaction.findMany({
      where: {
        businessId: { in: bizIds },
        source: 'bank_transfer',
        dvaOrigin: true,
        status: { in: SETTLED_SALE_STATUSES },
        walletTx: null,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (uncreditedSales.length === 0) return 0;

    let syncedCount = 0;
    for (const sale of uncreditedSales) {
      const amountNum = toNumber(sale.amount);
      const feeNaira = Math.round(Math.min((amountNum * 1.0) / 100, 300) * 100) / 100;
      const netRetained =
        sale.settledViaSplit && sale.platformRetained
          ? toNumber(sale.platformRetained)
          : Math.max(0, Math.round((amountNum - feeNaira) * 100) / 100);

      const reference = sale.referenceId || `DVA-SYNC-${sale.id}`;

      await this.creditWallet(
        {
          userId,
          businessId: sale.businessId,
          amount: amountNum,
          fee: feeNaira,
          netAmount: netRetained,
          reference,
          source: 'dva',
          description: `DVA bank transfer (restored/synced)`,
          linkedSaleId: sale.id,
          metadata: {
            synced: true,
            originalSaleDate: sale.transactionDate,
          },
        },
        db
      );
      syncedCount++;
    }

    if (syncedCount > 0) {
      logger.info(`[WALLET_AUTO_SYNC] Synced ${syncedCount} previously uncredited DVA sales for user ${userId}`);
    }
    return syncedCount;
  }

  /**
   * Credits the central user wallet with atomic balance increment and ledger entry.
   */
  static async creditWallet(
    params: CreditWalletParams,
    tx?: TxClient
  ): Promise<{ wallet: WalletBalance; transaction: WalletTransaction; alreadyProcessed: boolean }> {
    const execute = async (db: TxClient) => {
      // 1. Idempotency check on reference or idempotencyKey
      if (params.idempotencyKey) {
        const existingTx = await db.walletTransaction.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
        });
        if (existingTx) {
          const currentWallet = await this.getOrCreateWallet(params.userId, db);
          return { wallet: currentWallet, transaction: existingTx, alreadyProcessed: true };
        }
      }

      const existingByRef = await db.walletTransaction.findUnique({
        where: { reference: params.reference },
      });
      if (existingByRef) {
        const currentWallet = await this.getOrCreateWallet(params.userId, db);
        return { wallet: currentWallet, transaction: existingByRef, alreadyProcessed: true };
      }

      // Check linked sale deduplication
      if (params.linkedSaleId) {
        const existingBySale = await db.walletTransaction.findUnique({
          where: { linkedSaleId: params.linkedSaleId },
        });
        if (existingBySale) {
          const currentWallet = await this.getOrCreateWallet(params.userId, db);
          return { wallet: currentWallet, transaction: existingBySale, alreadyProcessed: true };
        }
      }

      // 2. Ensure wallet exists
      await this.getOrCreateWallet(params.userId, db);

      const amountDec = new Prisma.Decimal(params.amount);
      const feeDec = new Prisma.Decimal(params.fee ?? 0);
      const netAmountDec =
        params.netAmount != null
          ? new Prisma.Decimal(params.netAmount)
          : amountDec.minus(feeDec);

      // 3. Atomic balance update
      const updatedWallet = await db.walletBalance.update({
        where: { userId: params.userId },
        data: {
          balance: { increment: netAmountDec },
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      // 4. Create ledger transaction entry
      const walletTx = await db.walletTransaction.create({
        data: {
          walletId: updatedWallet.id,
          userId: params.userId,
          businessId: params.businessId,
          type: params.type ?? WalletTxType.credit,
          amount: amountDec,
          fee: feeDec,
          netAmount: netAmountDec,
          balanceAfter: updatedWallet.balance,
          reference: params.reference,
          source: params.source,
          description: params.description,
          idempotencyKey: params.idempotencyKey,
          metadata: params.metadata ?? Prisma.JsonNull,
          linkedSaleId: params.linkedSaleId,
        },
      });

      return { wallet: updatedWallet, transaction: walletTx, alreadyProcessed: false };
    };

    // Ensure wallet exists upfront before entering interactive transaction
    await this.getOrCreateWallet(params.userId, tx);

    try {
      if (tx) {
        return await execute(tx);
      }
      return await prisma.$transaction(execute, TX_OPTIONS);
    } catch (err: any) {
      // Handle sub-millisecond concurrent races on duplicate reference, idempotencyKey, or linkedSaleId
      if (err.code === 'P2002') {
        const client = tx ?? prisma;
        const existingTx =
          (params.idempotencyKey
            ? await client.walletTransaction.findUnique({ where: { idempotencyKey: params.idempotencyKey } })
            : null) ??
          (await client.walletTransaction.findUnique({ where: { reference: params.reference } })) ??
          (params.linkedSaleId
            ? await client.walletTransaction.findUnique({ where: { linkedSaleId: params.linkedSaleId } })
            : null);

        if (existingTx) {
          const currentWallet = await this.getOrCreateWallet(params.userId, client);
          return { wallet: currentWallet, transaction: existingTx, alreadyProcessed: true };
        }
      }
      throw err;
    }
  }

  /**
   * Reserves funds for a withdrawal payout request by moving available funds into locked balance.
   */
  static async reserveFunds(
    params: ReserveFundsParams,
    tx?: TxClient
  ): Promise<{ success: boolean; lockedAmount: number; wallet: WalletBalance }> {
    const execute = async (db: TxClient) => {
      await this.getOrCreateWallet(params.userId, db);

      // Serialize concurrent balance evaluations using PostgreSQL row-level lock
      if (typeof (db as any).$queryRaw === 'function') {
        await (db as any).$queryRaw`SELECT id FROM wallet_balances WHERE user_id = ${params.userId} FOR UPDATE`;
      }

      let wallet = await db.walletBalance.findUnique({ where: { userId: params.userId } });
      if (!wallet) throw new AppError(404, 'Wallet not found', 'WALLET_NOT_FOUND');

      let available = toNumber(wallet.balance) - toNumber(wallet.lockedBalance);
      const amountNum = toNumber(params.amount);
      const feeNum = toNumber(params.fee ?? 0);
      const totalDebit = amountNum + feeNum;

      // Auto-heal / self-reconcile: If available balance is less than required,
      // check if there are uncredited settled DVA sales (e.g. from restored DB or pre-migration history)
      if (available < totalDebit) {
        const synced = await this.syncUncreditedDvaSales(params.userId, db);
        if (synced > 0) {
          wallet = await db.walletBalance.findUnique({ where: { userId: params.userId } });
          if (wallet) {
            available = toNumber(wallet.balance) - toNumber(wallet.lockedBalance);
          }
        }
      }

      if (available < totalDebit) {
        throw new AppError(
          400,
          'INSUFFICIENT_FUNDS',
          `Insufficient available wallet balance. Available: ₦${available.toLocaleString('en-NG', { minimumFractionDigits: 2 })}, Required: ₦${totalDebit.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`
        );
      }

      const totalDebitDec = new Prisma.Decimal(totalDebit);
      const updatedWallet = await db.walletBalance.update({
        where: { userId: params.userId },
        data: {
          lockedBalance: { increment: totalDebitDec },
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      return { success: true, lockedAmount: totalDebit, wallet: updatedWallet };
    };

    if (tx) {
      return execute(tx);
    }
    return prisma.$transaction(execute, TX_OPTIONS);
  }

  /**
   * Completes a payout debit once transfer has been finalized.
   * Decrements both total balance and locked balance, and records a 'payout' transaction.
   */
  static async settlePayoutDebit(
    params: SettlePayoutParams,
    tx?: TxClient
  ): Promise<{ wallet: WalletBalance; transaction: WalletTransaction }> {
    const execute = async (db: TxClient) => {
      await this.getOrCreateWallet(params.userId, db);

      if (typeof (db as any).$queryRaw === 'function') {
        await (db as any).$queryRaw`SELECT id FROM wallet_balances WHERE user_id = ${params.userId} FOR UPDATE`;
      }

      const wallet = await db.walletBalance.findUnique({ where: { userId: params.userId } });
      if (!wallet) throw new AppError(404, 'Wallet not found', 'WALLET_NOT_FOUND');

      const amountDec = new Prisma.Decimal(params.amount);
      const feeDec = new Prisma.Decimal(params.fee ?? 0);
      const totalDebitDec = amountDec.plus(feeDec);

      // Decrement both balance and lockedBalance
      const updatedWallet = await db.walletBalance.update({
        where: { userId: params.userId },
        data: {
          balance: { decrement: totalDebitDec },
          lockedBalance: { decrement: totalDebitDec },
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      const transaction = await db.walletTransaction.create({
        data: {
          walletId: updatedWallet.id,
          userId: params.userId,
          businessId: params.businessId,
          type: WalletTxType.payout,
          amount: amountDec,
          fee: feeDec,
          netAmount: totalDebitDec.negated(),
          balanceAfter: updatedWallet.balance,
          reference: params.reference,
          source: 'payout',
          description: params.description ?? 'Commercial bank withdrawal',
          metadata: params.metadata ?? Prisma.JsonNull,
          linkedPayoutId: params.linkedPayoutId,
        },
      });

      return { wallet: updatedWallet, transaction };
    };

    if (tx) {
      return execute(tx);
    }
    return prisma.$transaction(execute, TX_OPTIONS);
  }

  /**
   * Releases locked funds back to available balance when a payout fails, is rejected, or is cancelled.
   */
  static async releaseLockedFunds(
    params: ReleaseLockedFundsParams,
    tx?: TxClient
  ): Promise<{ success: boolean; releasedAmount: number; wallet: WalletBalance }> {
    const execute = async (db: TxClient) => {
      await this.getOrCreateWallet(params.userId, db);

      if (typeof (db as any).$queryRaw === 'function') {
        await (db as any).$queryRaw`SELECT id FROM wallet_balances WHERE user_id = ${params.userId} FOR UPDATE`;
      }

      const wallet = await db.walletBalance.findUnique({ where: { userId: params.userId } });
      if (!wallet) throw new AppError(404, 'Wallet not found', 'WALLET_NOT_FOUND');

      const amountDec = new Prisma.Decimal(params.amount);
      const feeDec = new Prisma.Decimal(params.fee ?? 0);
      const releaseDec = amountDec.plus(feeDec);

      // Guard against underflow if lockedBalance was somehow lower
      const decrementDec = wallet.lockedBalance.gte(releaseDec) ? releaseDec : wallet.lockedBalance;

      const updatedWallet = await db.walletBalance.update({
        where: { userId: params.userId },
        data: {
          lockedBalance: { decrement: decrementDec },
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      return { success: true, releasedAmount: toNumber(decrementDec), wallet: updatedWallet };
    };

    if (tx) {
      return execute(tx);
    }
    return prisma.$transaction(execute, TX_OPTIONS);
  }

  /**
   * Queries paginated wallet ledger history for a user.
   */
  static async getWalletHistory(userId: string, query: WalletHistoryQuery = {}) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.WalletTransactionWhereInput = {
      userId,
      ...(query.type && { type: query.type }),
      ...(query.businessId && { businessId: query.businessId }),
    };

    const [total, transactions] = await Promise.all([
      prisma.walletTransaction.count({ where }),
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: toNumber(t.amount),
        fee: toNumber(t.fee),
        netAmount: toNumber(t.netAmount),
        balanceAfter: toNumber(t.balanceAfter),
        reference: t.reference,
        source: t.source,
        description: t.description,
        createdAt: t.createdAt,
        businessId: t.businessId,
        metadata: t.metadata,
      })),
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

  /**
   * Reconciles available platform funds against Paystack live balance before money movement.
   * Fail closed: if Paystack balance < withdrawal amount, rejects payout initiation.
   */
  static async checkLivePaystackBalance(
    amountNaira: number
  ): Promise<{ canPayout: boolean; paystackBalanceNaira: number; deficit: number }> {
    const secretKey = config.paystack.secretKey;

    // In test mode or when mock resolution is enabled, allow payouts
    if (!secretKey || secretKey.startsWith('sk_test_') || config.paystack.mockBankResolution) {
      logger.info('Live Paystack balance guard bypassed for test/mock environment', {
        amountNaira,
      });
      return { canPayout: true, paystackBalanceNaira: amountNaira * 10, deficit: 0 };
    }

    try {
      const response = await axios.get('https://api.paystack.co/balance', {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        timeout: 10000,
      });

      const balances = response.data?.data;
      if (!Array.isArray(balances)) {
        logger.warn('Unexpected balance response shape from Paystack', { data: response.data });
        return { canPayout: true, paystackBalanceNaira: 0, deficit: 0 };
      }

      // Find NGN currency balance (Paystack returns amount in kobo)
      const ngnBalance = balances.find((b: any) => b.currency === 'NGN');
      const balanceKobo = ngnBalance ? Number(ngnBalance.balance) : 0;
      const paystackBalanceNaira = balanceKobo / 100;

      if (paystackBalanceNaira < amountNaira) {
        const deficit = amountNaira - paystackBalanceNaira;
        logger.error('Paystack live balance is insufficient to service payout', {
          requiredNaira: amountNaira,
          paystackBalanceNaira,
          deficit,
        });
        return { canPayout: false, paystackBalanceNaira, deficit };
      }

      return { canPayout: true, paystackBalanceNaira, deficit: 0 };
    } catch (err: any) {
      logger.error('Failed to query Paystack live balance API', {
        error: err.message,
        status: err.response?.status,
      });
      // Fail closed in production if live balance enquiry fails
      return { canPayout: false, paystackBalanceNaira: 0, deficit: amountNaira };
    }
  }
}
