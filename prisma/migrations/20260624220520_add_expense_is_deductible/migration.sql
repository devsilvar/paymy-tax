-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "is_deductible" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "expenses_business_id_is_deductible_idx" ON "expenses"("business_id", "is_deductible");
