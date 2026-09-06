-- AlterTable businesses
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "auto_payout_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable settlement_payouts
ALTER TABLE "settlement_payouts" ADD COLUMN IF NOT EXISTS "admin_approved_by" TEXT;
ALTER TABLE "settlement_payouts" ADD COLUMN IF NOT EXISTS "admin_approved_at" TIMESTAMP(3);
