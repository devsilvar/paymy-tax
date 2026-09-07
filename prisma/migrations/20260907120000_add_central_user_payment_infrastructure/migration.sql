-- AlterTable users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "settlement_bank_code" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "settlement_bank_name" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "settlement_account_number" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "settlement_account_name" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "settlement_connected_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paystack_customer_code" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "virtual_account_number" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "virtual_account_bank" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "primary_business_id" TEXT;
