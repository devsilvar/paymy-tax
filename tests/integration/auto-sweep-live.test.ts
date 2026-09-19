import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import prisma from '../../src/lib/prisma';
import { runAutoSweep } from '../../src/jobs/wallet-auto-sweep.cron';
import { WalletService } from '../../src/services/wallet.service';
import * as paymentModule from '../../src/lib/payment';
import { toNumber } from '../../src/shared/helpers/number';

/**
 * ARCH-09 Live Database Auto-Sweep Verification
 *
 * This test executes against the REAL PostgreSQL database (NO DB MOCKS).
 * It proves that:
 * 1. Real Prisma transaction and foreign keys (User -> Business -> SettlementPayout) work.
 * 2. Real WalletBalance is decremented and lockedBalance is decremented.
 * 3. Real WalletTransaction of type 'payout' is appended to the ledger.
 * 4. Real SettlementPayout record is created and transitioned to 'completed'.
 */
describe('ARCH-09 Live Database Auto-Sweep Verification', () => {
  jest.setTimeout(30000);

  let testUser: any;
  let testBusiness: any;

  beforeAll(async () => {
    // Mock ONLY external network call to Paystack (never call real bank rails in tests)
    const mockProvider = {
      createTransferRecipient: jest.fn<any>().mockResolvedValue({
        recipientCode: 'RCP_live_sweep_test',
      }),
      initiateTransfer: jest.fn<any>().mockResolvedValue({
        status: 'success',
        transferCode: 'TRF_live_sweep_test',
      }),
    };
    jest.spyOn(paymentModule, 'getPaymentProvider').mockReturnValue(mockProvider as any);

    // Mock live Paystack balance query so it passes regardless of live account float
    jest.spyOn(WalletService, 'checkLivePaystackBalance').mockResolvedValue({
      canPayout: true,
      paystackBalanceNaira: 10000000,
      deficit: 0,
    });

    // Create unique test user in the REAL PostgreSQL database
    const uniqueSuffix = Date.now().toString();
    testUser = await prisma.user.create({
      data: {
        email: `autosweep-live-${uniqueSuffix}@example.com`,
        phone: `+23480${uniqueSuffix.slice(-8)}`,
        passwordHash: '$2b$12$dummyhashedpasswordfortestingonly123',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        settlementBankName: 'GTBank',
        settlementAccountName: 'Live Sweep Test Merchant',
      },
    });

    // Create business linked to user in the REAL PostgreSQL database
    testBusiness = await prisma.business.create({
      data: {
        userId: testUser.id,
        businessName: 'Live Sweep Enterprise',
        ownerName: 'Test Merchant',
        settlementAccountNumber: '0123456789',
        settlementBankCode: '058',
        settlementBankName: 'GTBank',
        settlementAccountName: 'Live Sweep Test Merchant',
        autoPayoutEnabled: true,
        merchantId: `MRCH-SWEEP-${uniqueSuffix}`,
      },
    });

    // Credit the real wallet with ₦5,000 in the REAL PostgreSQL database
    await WalletService.creditWallet({
      userId: testUser.id,
      businessId: testBusiness.id,
      amount: 5000,
      fee: 0,
      netAmount: 5000,
      reference: `CREDIT-TEST-${uniqueSuffix}`,
      source: 'test_deposit',
      description: 'Initial deposit for live auto-sweep test',
    });
  });

  afterAll(async () => {
    // Clean up test records
    if (testBusiness?.id) {
      await prisma.settlementPayout.deleteMany({
        where: { businessId: testBusiness.id },
      });
      await prisma.walletTransaction.deleteMany({
        where: { businessId: testBusiness.id },
      });
      await prisma.business.deleteMany({
        where: { id: testBusiness.id },
      });
    }
    if (testUser?.id) {
      await prisma.walletBalance.deleteMany({
        where: { userId: testUser.id },
      });
      await prisma.user.deleteMany({
        where: { id: testUser.id },
      });
    }
    await prisma.$disconnect();
  });

  test('executes auto-sweep end-to-end against real database tables', async () => {
    // 1. Verify pre-conditions in the real database
    const initialWallet = await prisma.walletBalance.findUnique({
      where: { userId: testUser.id },
    });
    expect(initialWallet).toBeDefined();
    expect(toNumber(initialWallet!.balance)).toBe(5000);
    expect(toNumber(initialWallet!.lockedBalance)).toBe(0);

    // 2. Run the sweep with bypassLock: true
    const result = await runAutoSweep({ bypassLock: true });

    expect(result.sweepsAttempted).toBeGreaterThanOrEqual(1);
    expect(result.sweepsCompleted).toBeGreaterThanOrEqual(1);

    // 3. Verify in the REAL database that a SettlementPayout record exists and is completed
    const payoutRecord = await prisma.settlementPayout.findFirst({
      where: { businessId: testBusiness.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(payoutRecord).toBeDefined();
    expect(payoutRecord!.status).toBe('completed');
    expect(toNumber(payoutRecord!.amount)).toBe(5000);
    expect(payoutRecord!.destinationBankCode).toBe('058');
    expect(payoutRecord!.destinationAccountNum).toBe('0123456789');
    expect(payoutRecord!.transferReference).toMatch(/^SWEEP-\d{8}-[A-F0-9]{10}$/);
    expect(payoutRecord!.paystackTransferCode).toBe('TRF_live_sweep_test');

    // 4. Verify in the REAL database that WalletBalance was debited to 0
    const finalWallet = await prisma.walletBalance.findUnique({
      where: { userId: testUser.id },
    });
    expect(toNumber(finalWallet!.balance)).toBe(0);
    expect(toNumber(finalWallet!.lockedBalance)).toBe(0);

    // 5. Verify in the REAL database that a payout WalletTransaction was recorded
    const payoutTx = await prisma.walletTransaction.findFirst({
      where: {
        userId: testUser.id,
        source: 'payout',
        linkedPayoutId: payoutRecord!.id,
      },
    });

    expect(payoutTx).toBeDefined();
    expect(toNumber(payoutTx!.amount)).toBe(5000);
    expect(toNumber(payoutTx!.netAmount)).toBe(-5000);
    expect(toNumber(payoutTx!.balanceAfter)).toBe(0);
  });
});
