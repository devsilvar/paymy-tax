-- AlterTable
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "logo_url" TEXT,
ADD COLUMN IF NOT EXISTS "logo_public_id" TEXT;
