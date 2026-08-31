import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function main() {
  console.log('Applying noticepay2 migrations via Prisma client...');

  // 1. Split-settlement columns on sales_transactions
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "sales_transactions"
      ADD COLUMN IF NOT EXISTS "settled_via_split" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "split_pct"         DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS "platform_retained" DECIMAL(15,2);
  `);
  console.log('✔ sales_transactions split-settlement columns applied');

  // 2. PIN attempt window column on users
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "pin_attempts_reset_at" TIMESTAMP(3);
  `);
  console.log('✔ users pin_attempts_reset_at column applied');

  console.log('All migrations applied successfully.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
