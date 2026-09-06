import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tx = await prisma.salesTransaction.findFirst({
    where: { amount: 800 },
  });
  console.log('--- 800 TRANSACTION DUMP ---');
  console.log(JSON.stringify(tx, null, 2));

  const biz = await prisma.business.findUnique({
    where: { id: tx?.businessId },
    select: {
      virtualAccountNumber: true,
      virtualAccountBank: true,
      paystackCustomerCode: true,
      paystackSubaccountCode: true,
      settlementAccountNumber: true,
      settlementBankName: true,
      settlementBankCode: true,
    },
  });
  console.log('--- BUSINESS DUMP ---');
  console.log(JSON.stringify(biz, null, 2));
}

main().finally(() => prisma.$disconnect());
