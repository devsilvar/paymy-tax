-- AlterTable
ALTER TABLE "sales_transactions"
  ADD COLUMN "settled_via_split" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "split_pct"         DECIMAL(5,2),
  ADD COLUMN "platform_retained" DECIMAL(15,2);
