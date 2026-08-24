-- CreateIndex
-- Composite index for tax calculation queries on sales transactions
-- Filters by businessId, status='confirmed', isTaxable=true, and date range
CREATE INDEX IF NOT EXISTS "idx_sales_tax_calc" ON "sales_transactions"("business_id", "status", "is_taxable", "transaction_date");

-- CreateIndex
-- Composite index for tax calculation queries on expenses
-- Filters by businessId, isDeductible=true, and date range
CREATE INDEX IF NOT EXISTS "idx_expense_tax_calc" ON "expenses"("business_id", "is_deductible", "expense_date");
