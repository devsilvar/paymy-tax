-- AlterTable
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "is_deductible" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "expenses_business_id_is_deductible_idx" ON "expenses"("business_id", "is_deductible");
