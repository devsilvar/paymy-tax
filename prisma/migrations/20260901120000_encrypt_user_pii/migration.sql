-- AlterTable
ALTER TABLE "users" RENAME COLUMN "bvn" TO "bvn_encrypted";
ALTER TABLE "users" RENAME COLUMN "nin" TO "nin_encrypted";
ALTER TABLE "users" ALTER COLUMN "bvn_encrypted" TYPE TEXT;
ALTER TABLE "users" ALTER COLUMN "nin_encrypted" TYPE TEXT;

-- DropIndex
DROP INDEX IF EXISTS "users_bvn_idx";

-- DropCheckConstraint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "check_bvn_length";
