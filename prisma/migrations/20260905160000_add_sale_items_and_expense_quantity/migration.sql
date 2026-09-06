-- CreateTable
CREATE TABLE "sale_line_items" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(15,2) NOT NULL,
    "line_total" DECIMAL(15,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_line_items_sale_id_sort_order_idx" ON "sale_line_items"("sale_id", "sort_order");

-- AddForeignKey
ALTER TABLE "sale_line_items" ADD CONSTRAINT "sale_line_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1;
ALTER TABLE "expenses" ADD COLUMN "unit_price" DECIMAL(15,2);

-- Backfill unit_price from amount for legacy expenses
UPDATE "expenses" SET "unit_price" = "amount" WHERE "unit_price" IS NULL;
