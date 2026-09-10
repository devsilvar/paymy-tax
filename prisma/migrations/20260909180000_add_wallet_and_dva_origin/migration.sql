-- AlterTable sales_transactions: add dva_origin
ALTER TABLE "sales_transactions" ADD COLUMN IF NOT EXISTS "dva_origin" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_transactions_business_id_dva_origin_status_idx" ON "sales_transactions"("business_id", "dva_origin", "status");

-- Backfill dva_origin on existing DVA sales
UPDATE "sales_transactions"
SET "dva_origin" = true
WHERE (metadata->>'channel' = 'dva')
   OR ("source" = 'bank_transfer' AND metadata->>'autoRecorded' = 'true');

-- CreateEnum WalletTxType
DO $$ BEGIN
  CREATE TYPE "WalletTxType" AS ENUM ('credit', 'debit', 'payout', 'fee', 'reversal');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable wallet_balances
CREATE TABLE IF NOT EXISTS "wallet_balances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "balance" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "locked_balance" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable wallet_transactions
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_id" TEXT,
    "type" "WalletTxType" NOT NULL DEFAULT 'credit',
    "amount" DECIMAL(15,2) NOT NULL,
    "fee" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "net_amount" DECIMAL(15,2) NOT NULL,
    "balance_after" DECIMAL(15,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "description" TEXT,
    "idempotency_key" TEXT,
    "metadata" JSONB,
    "linked_sale_id" TEXT,
    "linked_payout_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_balances_user_id_key" ON "wallet_balances"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_reference_key" ON "wallet_transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_idempotency_key_key" ON "wallet_transactions"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_linked_sale_id_key" ON "wallet_transactions"("linked_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_linked_payout_id_key" ON "wallet_transactions"("linked_payout_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_user_id_created_at_idx" ON "wallet_transactions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_business_id_idx" ON "wallet_transactions"("business_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_wallet_id_idx" ON "wallet_transactions"("wallet_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet_balances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_linked_sale_id_fkey" FOREIGN KEY ("linked_sale_id") REFERENCES "sales_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_linked_payout_id_fkey" FOREIGN KEY ("linked_payout_id") REFERENCES "settlement_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
