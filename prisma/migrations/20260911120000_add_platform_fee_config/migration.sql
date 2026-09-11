-- CreateTable
CREATE TABLE IF NOT EXISTS "platform_fee_configs" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "withdrawal_fee_pct" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    "withdrawal_fee_cap" DECIMAL(10,2) NOT NULL DEFAULT 300.00,
    "min_withdrawal_amount" DECIMAL(10,2) NOT NULL DEFAULT 1000.00,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "platform_fee_configs_pkey" PRIMARY KEY ("id")
);

-- Insert default row if not exists
INSERT INTO "platform_fee_configs" ("id", "withdrawal_fee_pct", "withdrawal_fee_cap", "min_withdrawal_amount", "updated_at")
VALUES ('default', 1.00, 300.00, 1000.00, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;