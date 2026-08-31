-- Add payout account change lock fields to Business model (idempotent)
-- These fields enforce admin-granted one-time permissions for changing settlement accounts

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'businesses' AND column_name = 'payout_change_permitted') THEN
    ALTER TABLE "businesses" ADD COLUMN "payout_change_permitted" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'businesses' AND column_name = 'payout_change_permitted_at') THEN
    ALTER TABLE "businesses" ADD COLUMN "payout_change_permitted_at" TIMESTAMP(3);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'businesses' AND column_name = 'payout_change_permitted_by') THEN
    ALTER TABLE "businesses" ADD COLUMN "payout_change_permitted_by" TEXT;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'businesses' AND column_name = 'payout_change_used_at') THEN
    ALTER TABLE "businesses" ADD COLUMN "payout_change_used_at" TIMESTAMP(3);
  END IF;
END $$;

-- Create index for efficient admin queries (who granted, when) - idempotent
CREATE INDEX IF NOT EXISTS "businesses_payout_change_permitted_by_idx" ON "businesses"("payout_change_permitted_by");
