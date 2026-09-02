import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function main() {
  console.log('Applying noticepay4 migrations via Prisma client...');

  await prisma.$executeRawUnsafe(`
    DO $$ 
    BEGIN
      -- Rename bvn to bvn_encrypted if bvn exists
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='bvn') THEN
        ALTER TABLE "users" RENAME COLUMN "bvn" TO "bvn_encrypted";
      END IF;
      
      -- Rename nin to nin_encrypted if nin exists
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='nin') THEN
        ALTER TABLE "users" RENAME COLUMN "nin" TO "nin_encrypted";
      END IF;

      -- Ensure column types are TEXT
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='bvn_encrypted') THEN
        ALTER TABLE "users" ALTER COLUMN "bvn_encrypted" TYPE TEXT;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='nin_encrypted') THEN
        ALTER TABLE "users" ALTER COLUMN "nin_encrypted" TYPE TEXT;
      END IF;

      -- Drop partial index if exists
      DROP INDEX IF EXISTS "users_bvn_idx";

      -- Drop check constraint if exists
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "check_bvn_length";
    END $$;
  `);

  console.log('✔ users bvn_encrypted & nin_encrypted columns, types, and constraints updated successfully');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
