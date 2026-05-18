-- AlterTable
ALTER TABLE "reminders" ADD COLUMN "reference_type" TEXT;
ALTER TABLE "reminders" ADD COLUMN "reference_id" TEXT;

-- CreateIndex
CREATE INDEX "reminders_business_id_reference_type_reference_id_idx" ON "reminders"("business_id", "reference_type", "reference_id");
