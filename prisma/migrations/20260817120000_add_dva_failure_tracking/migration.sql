-- Widen BVN storage + constraint from 11 to 11-or-12 digits.
--
-- Real Nigerian BVNs are always 11 digits. Paystack's OWN documented
-- test-mode identity-validation fixture, however, is the 12-digit value
-- "222222222221" (see https://paystack.com/docs/identity-verification/validate-customer/).
-- The previous VARCHAR(11) + CHECK(length = 11) made it impossible to ever
-- submit Paystack's real test credential, so BVN validation in test mode
-- could never succeed via the officially documented fixture.
ALTER TABLE "users" ALTER COLUMN "bvn" TYPE VARCHAR(12);
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "check_bvn_length";
ALTER TABLE "users" ADD CONSTRAINT "check_bvn_length"
  CHECK (bvn IS NULL OR length(bvn) IN (11, 12));

-- Track DVA identity-validation / dedicated-account-assignment failures.
--
-- Previously, a `customeridentification.failed` or
-- `dedicatedaccount.assign.failed` webhook was only logged server-side
-- (audit log) with no field on the business record to surface it. The
-- frontend's `GET /dva/virtual-account` polling endpoint therefore only
-- ever returned "active" or "none" — never "failed" — so the Account page
-- spinner had no way to know a failure had actually already happened, and
-- just spun until an arbitrary 5-minute client-side timeout.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "dva_failure_reason" TEXT;
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "dva_failed_at" TIMESTAMP;
