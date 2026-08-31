-- AlterTable (idempotent - safe to re-run)
-- Add columns only if they don't already exist
-- Updated: 2026-08-31 15:26 UTC - Force Render cache refresh
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'sales_transactions' AND column_name = 'settled_via_split') THEN
    ALTER TABLE "sales_transactions" ADD COLUMN "settled_via_split" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'sales_transactions' AND column_name = 'split_pct') THEN
    ALTER TABLE "sales_transactions" ADD COLUMN "split_pct" DECIMAL(5,2);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'sales_transactions' AND column_name = 'platform_retained') THEN
    ALTER TABLE "sales_transactions" ADD COLUMN "platform_retained" DECIMAL(15,2);
  END IF;
END $$;
