-- AlterTable
ALTER TABLE "businesses"
  ADD COLUMN "paystack_recipient_code" TEXT,
  ADD COLUMN "recipient_fingerprint"   TEXT;
