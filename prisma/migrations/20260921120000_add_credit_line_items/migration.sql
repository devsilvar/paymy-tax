-- CreateTable
CREATE TABLE "credit_line_items" (
    "id" TEXT NOT NULL,
    "credit_id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(15,2) NOT NULL,
    "line_total" DECIMAL(15,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_line_items_credit_id_sort_order_idx" ON "credit_line_items"("credit_id", "sort_order");

-- AddForeignKey
ALTER TABLE "credit_line_items" ADD CONSTRAINT "credit_line_items_credit_id_fkey" FOREIGN KEY ("credit_id") REFERENCES "customer_credits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
