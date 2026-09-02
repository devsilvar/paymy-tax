-- Add new expense categories.
-- Enum append is additive & non-blocking on Postgres 12+ (Neon/Supabase are 14+).
ALTER TYPE "ExpenseCategory" ADD VALUE 'gift';
ALTER TYPE "ExpenseCategory" ADD VALUE 'subscription';

-- Free-text detail captured when category = 'other' ("what do you mean by other?")
ALTER TABLE "expenses" ADD COLUMN "category_detail" TEXT;