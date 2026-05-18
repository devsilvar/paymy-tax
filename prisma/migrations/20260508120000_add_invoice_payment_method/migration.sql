-- CreateEnum
CREATE TYPE "InvoicePaymentMethod" AS ENUM ('cash', 'bank_transfer', 'pos', 'card', 'mobile_money', 'cheque', 'online', 'other');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "payment_method" "InvoicePaymentMethod";
