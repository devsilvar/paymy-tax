-- Add BVN/NIN fields to users table
ALTER TABLE "users" ADD COLUMN "bvn" VARCHAR(11);
ALTER TABLE "users" ADD COLUMN "nin" VARCHAR(11);
ALTER TABLE "users" ADD COLUMN "bvn_verified_at" TIMESTAMP;
ALTER TABLE "users" ADD COLUMN "nin_verified_at" TIMESTAMP;

-- Add index for BVN lookups
CREATE INDEX "users_bvn_idx" ON "users"("bvn") WHERE "bvn" IS NOT NULL;

-- Add check constraints for data integrity
ALTER TABLE "users" ADD CONSTRAINT "check_bvn_length" 
  CHECK (bvn IS NULL OR length(bvn) = 11);
ALTER TABLE "users" ADD CONSTRAINT "check_nin_length" 
  CHECK (nin IS NULL OR length(nin) = 11);
