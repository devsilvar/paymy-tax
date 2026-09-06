/**
 * Record Boss Payout Script
 *
 * Records the ₦800 payout that the boss triggered/sent to the merchant's OPay account.
 * Deducts ₦800 from the available wallet balance, bringing it from ₦1,100 to ₦300.
 * Creates an immutable audit log and payout record.
 *
 * Usage:
 *   npx tsx scripts/record-boss-payout.ts [amount]
 */
import 'dotenv/config';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const businessId = '0ca4c440-5358-4ac6-923c-71317014baf7';
const amount = Number(process.argv[2] ?? 800);

async function main() {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      userId: true,
      businessName: true,
      settlementBankCode: true,
      settlementBankName: true,
      settlementAccountNumber: true,
      settlementAccountName: true,
    },
  });

  if (!business) {
    console.error('❌ Business not found');
    return;
  }

  const bankCode = business.settlementBankCode || '999992';
  const bankName = business.settlementBankName || 'OPay Digital Services Limited (OPay)';
  const accountNum = business.settlementAccountNumber || '8148434507';
  const accountName = business.settlementAccountName || 'YUSUF SILVA AIYEGBAJEJE';

  const transferReference = `PO-LIVE-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  console.log(`\nRecording ₦${amount} payout for ${business.businessName}...`);

  await prisma.$transaction(async (tx) => {
    // 1. Create completed SettlementPayout row
    const payout = await tx.settlementPayout.create({
      data: {
        businessId: business.id,
        amount,
        fee: 0,
        netAmount: amount,
        destinationBankCode: bankCode,
        destinationBankName: bankName,
        destinationAccountNum: accountNum,
        destinationAccountName: accountName,
        transferReference,
        status: 'completed',
        completedAt: new Date(),
        narration: `Payout of ₦${amount} sent to OPay by platform admin`,
      },
    });

    // 2. Audit log entry
    await tx.auditLog.create({
      data: {
        userId: business.userId,
        businessId: business.id,
        action: 'settlement.payout_completed',
        resourceType: 'settlement_payout',
        resourceId: payout.id,
        newData: {
          amount,
          transferReference,
          destinationBank: bankName,
          accountNumber: accountNum,
          accountName,
          status: 'completed',
          reason: 'Recorded payout sent by boss/admin to clear ₦800 from available wallet balance',
        },
      },
    });

    console.log(`✅ Payout recorded successfully! Reference: ${transferReference}`);
  });
}

main()
  .catch((err) => {
    console.error('❌ Error recording payout:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
