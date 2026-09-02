import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function main() {
  console.log('Applying noticepay3 migrations via Prisma client...');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "businesses"
      ADD COLUMN IF NOT EXISTS "paystack_recipient_code" TEXT,
      ADD COLUMN IF NOT EXISTS "recipient_fingerprint"   TEXT;
  `);
  console.log('✔ businesses paystack_recipient_code and recipient_fingerprint columns applied');

  console.log('All noticepay3 migrations applied successfully.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
