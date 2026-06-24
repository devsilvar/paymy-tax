-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "paystack_subaccount_code" TEXT,
ADD COLUMN     "settlement_bank_code" TEXT,
ADD COLUMN     "settlement_bank_name" TEXT,
ADD COLUMN     "settlement_account_number" TEXT,
ADD COLUMN     "settlement_account_name" TEXT,
ADD COLUMN     "platform_commission_pct" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
ADD COLUMN     "settlement_connected_at" TIMESTAMP(3);
