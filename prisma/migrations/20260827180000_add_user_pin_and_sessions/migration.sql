-- AlterTable
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "transaction_pin" TEXT,
ADD COLUMN IF NOT EXISTS "pin_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "pin_locked_until" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "pin_set_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_info" TEXT,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX IF NOT EXISTS "sessions_refresh_token_hash_idx" ON "sessions"("refresh_token_hash");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sessions_user_id_fkey'
    ) THEN
        ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
