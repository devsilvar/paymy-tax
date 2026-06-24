-- CreateEnum
CREATE TYPE "TransactionCategory" AS ENUM ('revenue', 'capital', 'loan', 'transfer', 'refund', 'grant', 'gift', 'investment', 'tax_refund', 'insurance', 'asset_sale', 'other');

-- CreateEnum
CREATE TYPE "TaxTreatment" AS ENUM ('taxable', 'non_taxable', 'review_required');

-- CreateTable
CREATE TABLE "transaction_classifications" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "TransactionCategory" NOT NULL,
    "tax_treatment" "TaxTreatment" NOT NULL,
    "is_revenue" BOOLEAN NOT NULL DEFAULT false,
    "is_expense" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_classifications_pkey" PRIMARY KEY ("id")
);

-- AddColumn to SalesTransaction
ALTER TABLE "sales_transactions" ADD COLUMN "classification_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transaction_classifications_name_key" ON "transaction_classifications"("name");

-- CreateIndex
CREATE INDEX "transaction_classifications_category_idx" ON "transaction_classifications"("category");

-- CreateIndex
CREATE INDEX "transaction_classifications_is_active_idx" ON "transaction_classifications"("is_active");

-- AddForeignKey
ALTER TABLE "sales_transactions" ADD CONSTRAINT "sales_transactions_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "transaction_classifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "sales_transactions_classification_id_idx" ON "sales_transactions"("classification_id");
