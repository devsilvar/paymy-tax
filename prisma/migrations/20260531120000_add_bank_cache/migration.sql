-- CreateTable
--
-- Cached copy of Paystack `GET /bank?country=nigeria`. Backs the
-- BVN / bank-account validation flow (Paystack moved from `type:'bvn'` to
-- `type:'bank_account'` which requires `account_number + bank_code` alongside
-- the BVN). See backend/src/services/bank.service.ts for the 24h refresh
-- strategy.
CREATE TABLE "banks" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "long_code" TEXT,
    "country" TEXT NOT NULL DEFAULT 'nigeria',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "banks_slug_key" ON "banks"("slug");

-- CreateIndex
CREATE INDEX "banks_country_active_idx" ON "banks"("country", "active");

-- CreateIndex
CREATE INDEX "banks_code_idx" ON "banks"("code");
