import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { getWithdrawalActor } from '../../src/shared/helpers/withdrawal-actor';
import prisma, { TxClient } from '../../src/lib/prisma';
import { AppError } from '../../src/middleware/errorHandler';

describe('getWithdrawalActor Security Suite', () => {
  const mockUserId = 'user-test-uuid-1';
  const mockBusinessId = 'biz-test-uuid-1';

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('successfully retrieves business and uncached live user security state', async () => {
    const mockDbRecord = {
      id: mockBusinessId,
      userId: mockUserId,
      name: 'Alpha Enterprises',
      user: {
        id: mockUserId,
        email: 'ceo@alpha.ng',
        transactionPin: '$2b$12$hashedpin...',
        pinLockedUntil: null,
        pinAttempts: 0,
        settlementBankCode: '058',
        settlementBankName: 'Guaranty Trust Bank',
        settlementAccountNumber: '0123456789',
        settlementAccountName: 'ALPHA ENTERPRISES',
        settlementConnectedAt: new Date(),
        virtualAccountNumber: '9988776655',
        virtualAccountBank: 'Wema Bank',
        paystackCustomerCode: 'CUS_xyz123',
        primaryBusinessId: mockBusinessId,
      },
    };

    const findFirstSpy = jest
      .spyOn(prisma.business, 'findFirst')
      .mockResolvedValue(mockDbRecord as any);

    const result = await getWithdrawalActor(mockUserId, mockBusinessId);

    expect(findFirstSpy).toHaveBeenCalledWith({
      where: { id: mockBusinessId, userId: mockUserId },
      include: expect.objectContaining({
        user: expect.objectContaining({
          select: expect.objectContaining({
            pinLockedUntil: true,
            pinAttempts: true,
            transactionPin: true,
            settlementAccountNumber: true,
          }),
        }),
      }),
    });

    expect(result.id).toBe(mockBusinessId);
    expect(result.user.pinLockedUntil).toBeNull();
    expect(result.user.pinAttempts).toBe(0);
  });

  test('throws 404 AppError BUSINESS_NOT_FOUND when record is not found', async () => {
    jest.spyOn(prisma.business, 'findFirst').mockResolvedValue(null as any);

    await expect(
      getWithdrawalActor('other-user-uuid', mockBusinessId)
    ).rejects.toThrow(AppError);

    try {
      await getWithdrawalActor('other-user-uuid', mockBusinessId);
    } catch (err: any) {
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('BUSINESS_NOT_FOUND');
    }
  });

  test('never caches: subsequent calls immediately reflect live PIN lockout changes', async () => {
    // 1st call: user is not locked
    const activeUser = {
      id: mockBusinessId,
      userId: mockUserId,
      user: {
        id: mockUserId,
        pinLockedUntil: null,
        pinAttempts: 2,
      },
    };

    // 2nd call (e.g. after failed attempt triggers lockout): user is locked for 30 minutes
    const lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
    const lockedUser = {
      id: mockBusinessId,
      userId: mockUserId,
      user: {
        id: mockUserId,
        pinLockedUntil: lockedUntil,
        pinAttempts: 3,
      },
    };

    const findFirstSpy = jest
      .spyOn(prisma.business, 'findFirst')
      .mockResolvedValueOnce(activeUser as any)
      .mockResolvedValueOnce(lockedUser as any);

    const firstCall = await getWithdrawalActor(mockUserId, mockBusinessId);
    expect(firstCall.user.pinLockedUntil).toBeNull();
    expect(firstCall.user.pinAttempts).toBe(2);

    const secondCall = await getWithdrawalActor(mockUserId, mockBusinessId);
    expect(secondCall.user.pinLockedUntil).toEqual(lockedUntil);
    expect(secondCall.user.pinAttempts).toBe(3);

    // Verify both calls hit the database directly without in-memory caching
    expect(findFirstSpy).toHaveBeenCalledTimes(2);
  });

  test('executes on transactional client tx when supplied', async () => {
    const mockTx = {
      business: {
        findFirst: jest.fn().mockResolvedValue({
          id: mockBusinessId,
          userId: mockUserId,
          user: { id: mockUserId, pinAttempts: 0 },
        } as any),
      },
    } as unknown as TxClient;

    const prismaSpy = jest.spyOn(prisma.business, 'findFirst');

    const result = await getWithdrawalActor(mockUserId, mockBusinessId, mockTx);

    expect(mockTx.business.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaSpy).not.toHaveBeenCalled();
    expect(result.id).toBe(mockBusinessId);
  });
});
