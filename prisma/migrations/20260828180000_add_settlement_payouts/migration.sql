-- AlterTable
ALTER TABLE "businesses" ADD COLUMN "auto_split_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "tax_split_percentage" DECIMAL(5,2) NOT NULL DEFAULT 7.50;

-- CreateTable
CREATE TABLE "settlement_payouts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(15,2) NOT NULL,
    "destination_bank_code" TEXT NOT NULL,
    "destination_bank_name" TEXT NOT NULL,
    "destination_account_num" TEXT NOT NULL,
    "destination_account_name" TEXT NOT NULL,
    "transfer_reference" TEXT NOT NULL,
    "paystack_transfer_code" TEXT,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "narration" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_payouts_transfer_reference_key" ON "settlement_payouts"("transfer_reference");

-- CreateIndex
CREATE INDEX "settlement_payouts_business_id_idx" ON "settlement_payouts"("business_id");

-- CreateIndex
CREATE INDEX "settlement_payouts_transfer_reference_idx" ON "settlement_payouts"("transfer_reference");

-- CreateIndex
CREATE INDEX "settlement_payouts_payment_status_idx" ON "settlement_payouts"("payment_status");

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
