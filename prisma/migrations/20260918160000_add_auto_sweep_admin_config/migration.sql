-- AlterTable
ALTER TABLE "platform_fee_configs" ADD COLUMN IF NOT EXISTS "auto_sweep_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "platform_fee_configs" ADD COLUMN IF NOT EXISTS "auto_sweep_threshold" DECIMAL(10,2) NOT NULL DEFAULT 1000.00;
