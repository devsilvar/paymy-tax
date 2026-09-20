-- CreateEnum
CREATE TYPE "CreditStatus" AS ENUM ('unpaid', 'partially_paid', 'paid', 'written_off', 'overdue');

-- CreateTable
CREATE TABLE "customer_credits" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "customer_email" TEXT,
    "description" TEXT NOT NULL,
    "total_amount" DECIMAL(15,2) NOT NULL,
    "amount_paid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(15,2) NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "reminder_date" DATE,
    "last_reminder_sent_at" TIMESTAMP(3),
    "status" "CreditStatus" NOT NULL DEFAULT 'unpaid',
    "guarantor_name" TEXT,
    "guarantor_phone" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_payments" (
    "id" TEXT NOT NULL,
    "credit_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "payment_date" DATE NOT NULL,
    "payment_type" "SalesSource" NOT NULL,
    "is_full_payment" BOOLEAN NOT NULL DEFAULT false,
    "linked_sale_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_credits_business_id_status_idx" ON "customer_credits"("business_id", "status");

-- CreateIndex
CREATE INDEX "customer_credits_business_id_due_date_idx" ON "customer_credits"("business_id", "due_date");

-- CreateIndex
CREATE INDEX "customer_credits_due_date_status_idx" ON "customer_credits"("due_date", "status");

-- CreateIndex
CREATE INDEX "customer_credits_reminder_date_status_idx" ON "customer_credits"("reminder_date", "status");

-- CreateIndex
CREATE INDEX "customer_credits_customer_id_idx" ON "customer_credits"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_payments_linked_sale_id_key" ON "credit_payments"("linked_sale_id");

-- CreateIndex
CREATE INDEX "credit_payments_credit_id_idx" ON "credit_payments"("credit_id");

-- CreateIndex
CREATE INDEX "credit_payments_payment_date_idx" ON "credit_payments"("payment_date");

-- AddForeignKey
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_payments" ADD CONSTRAINT "credit_payments_credit_id_fkey" FOREIGN KEY ("credit_id") REFERENCES "customer_credits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_payments" ADD CONSTRAINT "credit_payments_linked_sale_id_fkey" FOREIGN KEY ("linked_sale_id") REFERENCES "sales_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
