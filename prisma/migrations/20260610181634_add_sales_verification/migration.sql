-- AlterTable
ALTER TABLE "sales_transactions" ADD COLUMN     "customer_hint" TEXT,
ADD COLUMN     "final_classification" TEXT,
ADD COLUMN     "is_taxable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "needs_verification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "verified_by" TEXT;

-- CreateIndex
CREATE INDEX "idx_sales_needs_verification" ON "sales_transactions"("business_id", "needs_verification");
