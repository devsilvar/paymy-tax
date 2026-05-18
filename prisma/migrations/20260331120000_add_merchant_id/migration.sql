-- AlterTable: Add merchant_id column (nullable first to backfill existing rows)
ALTER TABLE "businesses" ADD COLUMN "merchant_id" TEXT;

-- Backfill existing rows with sequential merchant IDs
UPDATE "businesses"
SET "merchant_id" = 'PMTW' || LPAD(ROW_NUMBER::TEXT, 7, '0')
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS ROW_NUMBER
  FROM "businesses"
) AS numbered
WHERE "businesses"."id" = numbered.id;

-- Now make it required and unique
ALTER TABLE "businesses" ALTER COLUMN "merchant_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "businesses_merchant_id_key" ON "businesses"("merchant_id");
