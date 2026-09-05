-- Retire the 'manual' payment type (salesexpense.md Phase B).
-- Rows WITHOUT a referenceId are safe to flip to 'cash' — they can't collide
-- with the unique_sales_reference constraint on (businessId, source, referenceId)
-- because cash rows with no reference are exempt from that constraint.
-- Rows WITH a referenceId keep 'manual' (rare; enum member stays valid).
UPDATE "sales_transactions"
SET "source" = 'cash'
WHERE "source" = 'manual'
  AND "reference_id" IS NULL;