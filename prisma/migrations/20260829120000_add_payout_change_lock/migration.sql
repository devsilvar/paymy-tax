-- Add payout account change lock fields to Business model
-- These fields enforce admin-granted one-time permissions for changing settlement accounts

ALTER TABLE "businesses" 
ADD COLUMN "payout_change_permitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "payout_change_permitted_at" TIMESTAMP(3),
ADD COLUMN "payout_change_permitted_by" TEXT,
ADD COLUMN "payout_change_used_at" TIMESTAMP(3);

-- Create index for efficient admin queries (who granted, when)
CREATE INDEX "businesses_payout_change_permitted_by_idx" ON "businesses"("payout_change_permitted_by");
