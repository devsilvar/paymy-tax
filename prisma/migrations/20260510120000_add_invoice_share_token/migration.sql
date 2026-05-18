-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "share_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoices_share_token_key" ON "invoices"("share_token");
