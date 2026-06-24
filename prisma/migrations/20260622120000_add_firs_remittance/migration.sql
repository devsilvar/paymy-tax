-- CreateEnum
CREATE TYPE "RemittanceStatus" AS ENUM ('collected', 'remitting', 'remitted');

-- AlterTable
ALTER TABLE "tax_payments" ADD COLUMN     "remittance_id" TEXT,
ADD COLUMN     "remittance_status" "RemittanceStatus" NOT NULL DEFAULT 'collected';

-- CreateTable
CREATE TABLE "firs_remittances" (
    "id" TEXT NOT NULL,
    "status" "RemittanceStatus" NOT NULL DEFAULT 'remitting',
    "total_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "payment_count" INTEGER NOT NULL DEFAULT 0,
    "firs_reference" TEXT,
    "firs_receipt_url" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_by" TEXT,
    "remitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firs_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "firs_remittances_status_idx" ON "firs_remittances"("status");

-- CreateIndex
CREATE INDEX "firs_remittances_created_at_idx" ON "firs_remittances"("created_at" DESC);

-- CreateIndex
CREATE INDEX "tax_payments_remittance_status_idx" ON "tax_payments"("remittance_status");

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_remittance_id_fkey" FOREIGN KEY ("remittance_id") REFERENCES "firs_remittances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
