-- Drop obsolete length constraint on bvn to allow storing AES-256-GCM ciphertexts
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "check_bvn_length";

-- Widen bvn and nin columns to TEXT for encrypted payload storage
ALTER TABLE "users" ALTER COLUMN "bvn" TYPE TEXT;
ALTER TABLE "users" ALTER COLUMN "nin" TYPE TEXT;

-- Add blind index columns for deterministic HMAC-SHA256 uniqueness lookups
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bvn_hash" VARCHAR(64);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "nin_hash" VARCHAR(64);

-- Replace plaintext bvn index with blind index indexes
DROP INDEX IF EXISTS "users_bvn_idx";
CREATE INDEX IF NOT EXISTS "users_bvn_hash_idx" ON "users"("bvn_hash");
CREATE INDEX IF NOT EXISTS "users_nin_hash_idx" ON "users"("nin_hash");
