# Deployment Fix: Stuck Prisma Migrations

## Problem
Render deployment failing with:
```
ERROR: column "settled_via_split" of relation "sales_transactions" already exists
```

## Root Cause
The migration `20260830120000_add_sales_split_ledger` is trying to add columns that already exist in the production database. Prisma's `_prisma_migrations` table doesn't have a successful record of this migration, so it keeps trying to run it.

## Solution

### Option 1: Manual Database Fix (Recommended - 2 minutes)

1. **Open Supabase SQL Editor**:
   - Go to: https://supabase.com/dashboard/project/_/sql
   - Or your Supabase project → SQL Editor

2. **Run this query**:
   ```sql
   -- Delete the failed migration record
   DELETE FROM "_prisma_migrations"
   WHERE migration_name = '20260830120000_add_sales_split_ledger';
   ```

3. **Trigger Render redeploy**:
   - Go to Render dashboard
   - Click "Manual Deploy" → "Clear build cache & deploy"
   - The idempotent migration will now run successfully

### Option 2: Mark Migration as Applied (Alternative)

If you want to skip the migration entirely:

```sql
-- Mark as successfully applied
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
  '',
  NOW(),
  '20260830120000_add_sales_split_ledger',
  'Manually marked as applied - columns already exist',
  NULL,
  NOW(),
  1
)
ON CONFLICT DO NOTHING;
```

Then redeploy.

### Option 3: Prisma Migrate Resolve (If you have database access from terminal)

```bash
# Mark the migration as resolved
npx prisma migrate resolve --applied 20260830120000_add_sales_split_ledger
```

## Verification

After fix, check health endpoint:
```
https://paymy-tax.onrender.com/api/health
```

Should show latest commit and no errors.

## Prevention

All recent migrations have been made idempotent (use `IF NOT EXISTS`), so this won't happen again with future deployments.
