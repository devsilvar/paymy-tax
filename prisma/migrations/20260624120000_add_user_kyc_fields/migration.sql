-- Add BVN/NIN fields to users table
-- Using IF NOT EXISTS to handle partial-apply recovery (P3018).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bvn" VARCHAR(11);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "nin" VARCHAR(11);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bvn_verified_at" TIMESTAMP;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "nin_verified_at" TIMESTAMP;

-- Add index for BVN lookups
CREATE INDEX IF NOT EXISTS "users_bvn_idx" ON "users"("bvn") WHERE "bvn" IS NOT NULL;

-- Add check constraints for data integrity
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "check_bvn_length";
ALTER TABLE "users" ADD CONSTRAINT "check_bvn_length"
  CHECK (bvn IS NULL OR length(bvn) = 11);
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "check_nin_length";
ALTER TABLE "users" ADD CONSTRAINT "check_nin_length"
  CHECK (nin IS NULL OR length(nin) = 11);
