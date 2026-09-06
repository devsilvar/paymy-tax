import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function main() {
  console.log('Applying sale_line_items and expense quantity migration via Prisma client...');

  // 1. Create sale_line_items table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "sale_line_items" (
      "id" TEXT NOT NULL,
      "sale_id" TEXT NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
      "unit_price" DECIMAL(15,2) NOT NULL,
      "line_total" DECIMAL(15,2) NOT NULL,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "sale_line_items_pkey" PRIMARY KEY ("id")
    );
  `);
  console.log('✔ sale_line_items table ready');

  // 2. Create index
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "sale_line_items_sale_id_sort_order_idx" 
      ON "sale_line_items"("sale_id", "sort_order");
  `);
  console.log('✔ sale_line_items index ready');

  // 3. Add FK constraint if not exists
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sale_line_items_sale_id_fkey'
      ) THEN
        ALTER TABLE "sale_line_items"
          ADD CONSTRAINT "sale_line_items_sale_id_fkey"
          FOREIGN KEY ("sale_id") REFERENCES "sales_transactions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
  console.log('✔ foreign key constraint ready');

  // 4. Alter expenses table
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "expenses" 
      ADD COLUMN IF NOT EXISTS "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "unit_price" DECIMAL(15,2);
  `);
  console.log('✔ expenses quantity and unit_price columns added');

  // 5. Backfill unit_price from amount
  const backfilled = await prisma.$executeRawUnsafe(`
    UPDATE "expenses"
      SET "unit_price" = "amount"
      WHERE "unit_price" IS NULL;
  `);
  console.log(`✔ backfilled unit_price on ${backfilled} legacy expense rows`);

  // 6. Record in _prisma_migrations if table exists
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
      VALUES (
        gen_random_uuid(),
        'manual_override',
        NOW(),
        '20260905160000_add_sale_items_and_expense_quantity',
        NULL,
        NULL,
        NOW(),
        1
      )
      ON CONFLICT DO NOTHING;
    `);
    console.log('✔ recorded in _prisma_migrations');
  } catch (err) {
    console.log('Note: _prisma_migrations recording skipped or not needed');
  }

  console.log('All migrations applied successfully.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
