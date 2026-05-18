-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('wallet', 'bank_transfer', 'card', 'paycode');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'processing', 'completed', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "SalesSource" AS ENUM ('bank_transfer', 'paycode', 'pos', 'online_store', 'manual');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('confirmed', 'pending', 'reversed', 'disputed');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('rent', 'inventory', 'salary', 'utility', 'fuel', 'logistics', 'marketing', 'other');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "phone" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "tax_id" TEXT,
    "business_type" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "paystack_customer_code" TEXT,
    "virtual_account_number" TEXT,
    "virtual_account_bank" TEXT,
    "default_profit_margin" DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    "tax_reminder_day" INTEGER NOT NULL DEFAULT 25,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_transactions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "source" "SalesSource" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'confirmed',
    "reference_id" TEXT,
    "description" TEXT,
    "customer_name" TEXT,
    "transaction_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "metadata" JSONB,

    CONSTRAINT "sales_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "expense_date" DATE NOT NULL,
    "receipt_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_tax_reports" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "tax_month" DATE NOT NULL,
    "total_sales" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_expenses" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "gross_profit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 7.5,
    "tax_payable" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "profit_margin" DECIMAL(5,2),
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "is_finalized" BOOLEAN NOT NULL DEFAULT false,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_tax_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_payments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "tax_report_id" TEXT NOT NULL,
    "amount_paid" DECIMAL(15,2) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "transaction_reference" TEXT NOT NULL,
    "gateway_response" JSONB,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "payment_date" TIMESTAMP(3),
    "firs_remittance_ref" TEXT,
    "firs_receipt_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_statements" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "tax_report_id" TEXT NOT NULL,
    "pdf_url" TEXT NOT NULL,
    "pdf_size_bytes" INTEGER,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "tax_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "business_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "old_data" JSONB,
    "new_data" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "reminder_type" TEXT NOT NULL,
    "scheduled_date" DATE NOT NULL,
    "is_sent" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_tax_id_key" ON "businesses"("tax_id");

-- CreateIndex
CREATE INDEX "businesses_user_id_idx" ON "businesses"("user_id");

-- CreateIndex
CREATE INDEX "businesses_tax_id_idx" ON "businesses"("tax_id");

-- CreateIndex
CREATE INDEX "sales_transactions_business_id_transaction_date_idx" ON "sales_transactions"("business_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "sales_transactions_reference_id_idx" ON "sales_transactions"("reference_id");

-- CreateIndex
CREATE INDEX "sales_transactions_source_idx" ON "sales_transactions"("source");

-- CreateIndex
CREATE UNIQUE INDEX "sales_transactions_business_id_source_reference_id_key" ON "sales_transactions"("business_id", "source", "reference_id");

-- CreateIndex
CREATE INDEX "expenses_business_id_expense_date_idx" ON "expenses"("business_id", "expense_date" DESC);

-- CreateIndex
CREATE INDEX "expenses_category_idx" ON "expenses"("category");

-- CreateIndex
CREATE INDEX "monthly_tax_reports_business_id_tax_month_idx" ON "monthly_tax_reports"("business_id", "tax_month" DESC);

-- CreateIndex
CREATE INDEX "monthly_tax_reports_payment_status_idx" ON "monthly_tax_reports"("payment_status");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_tax_reports_business_id_tax_month_key" ON "monthly_tax_reports"("business_id", "tax_month");

-- CreateIndex
CREATE UNIQUE INDEX "tax_payments_transaction_reference_key" ON "tax_payments"("transaction_reference");

-- CreateIndex
CREATE INDEX "tax_payments_business_id_idx" ON "tax_payments"("business_id");

-- CreateIndex
CREATE INDEX "tax_payments_transaction_reference_idx" ON "tax_payments"("transaction_reference");

-- CreateIndex
CREATE INDEX "tax_payments_payment_status_idx" ON "tax_payments"("payment_status");

-- CreateIndex
CREATE UNIQUE INDEX "tax_statements_tax_report_id_key" ON "tax_statements"("tax_report_id");

-- CreateIndex
CREATE INDEX "tax_statements_business_id_idx" ON "tax_statements"("business_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_business_id_created_at_idx" ON "audit_logs"("business_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "reminders_scheduled_date_is_sent_idx" ON "reminders"("scheduled_date", "is_sent");

-- CreateIndex
CREATE INDEX "reminders_business_id_idx" ON "reminders"("business_id");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_transactions" ADD CONSTRAINT "sales_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_tax_reports" ADD CONSTRAINT "monthly_tax_reports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_tax_report_id_fkey" FOREIGN KEY ("tax_report_id") REFERENCES "monthly_tax_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_statements" ADD CONSTRAINT "tax_statements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_statements" ADD CONSTRAINT "tax_statements_tax_report_id_fkey" FOREIGN KEY ("tax_report_id") REFERENCES "monthly_tax_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
