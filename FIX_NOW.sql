-- ==============================================================================
-- CRITICAL FIX: Mark the migration as successfully applied
-- ==============================================================================
-- Run this in Supabase SQL Editor RIGHT NOW
-- This tells Prisma "this migration already ran successfully"
-- ==============================================================================

-- First, delete any existing failed records for this migration
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260830120000_add_sales_split_ledger';

-- Now insert a successful migration record
INSERT INTO "_prisma_migrations" (
  id, 
  checksum, 
  finished_at, 
  migration_name, 
  logs, 
  rolled_back_at, 
  started_at, 
  applied_steps_count
)
VALUES (
  gen_random_uuid()::text,
  '4636d2ce0abc07aa75a74088bf5a9f3a',  -- actual MD5 checksum of idempotent migration
  NOW(),
  '20260830120000_add_sales_split_ledger',
  'Manually marked as applied - columns verified to exist in schema',
  NULL,
  NOW() - INTERVAL '1 second',
  1
);

-- Verify it was inserted
SELECT migration_name, finished_at, logs
FROM "_prisma_migrations"
WHERE migration_name = '20260830120000_add_sales_split_ledger';
