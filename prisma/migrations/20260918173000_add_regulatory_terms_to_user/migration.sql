-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "regulatory_terms_accepted_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "regulatory_terms_version" TEXT;
