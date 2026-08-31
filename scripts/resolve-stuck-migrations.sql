/**
 * Manual Migration Resolution Script
 * 
 * Run this when Prisma migrations are stuck due to failed migrations with existing columns.
 * 
 * This script:
 * 1. Marks failed migrations as rolled back
 * 2. Marks them as successfully applied if columns exist
 * 3. Allows `prisma migrate deploy` to continue
 * 
 * USAGE:
 * 1. Connect to your production database (Supabase SQL Editor)
 * 2. Run the SQL queries below
 * 3. Re-deploy your app
 */

-- Step 1: Check current migration status
SELECT migration_name, finished_at, rolled_back_at, logs 
FROM "_prisma_migrations" 
WHERE migration_name LIKE '%add_sales_split_ledger%' 
   OR migration_name LIKE '%add_settlement_payouts%'
   OR migration_name LIKE '%add_payout_change_lock%'
   OR migration_name LIKE '%add_pin_attempt_window%'
ORDER BY started_at DESC;

-- Step 2: Mark the failed migration as rolled back (if it shows as failed)
UPDATE "_prisma_migrations"
SET rolled_back_at = NOW(),
    logs = 'Manually rolled back - columns already existed'
WHERE migration_name = '20260830120000_add_sales_split_ledger'
  AND finished_at IS NULL
  AND rolled_back_at IS NULL;

-- Step 3: Delete the failed migration record to allow retry
DELETE FROM "_prisma_migrations"
WHERE migration_name IN (
  '20260830120000_add_sales_split_ledger',
  '20260828180000_add_settlement_payouts',
  '20260829120000_add_payout_change_lock',
  '20260830130000_add_pin_attempt_window'
)
AND (finished_at IS NULL OR rolled_back_at IS NOT NULL);

-- Step 4: Verify the columns exist (they should)
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'sales_transactions' 
  AND column_name IN ('settled_via_split', 'split_pct', 'platform_retained')
ORDER BY column_name;

-- After running this, trigger a new Render deployment.
-- The idempotent migrations will run and skip adding existing columns.
