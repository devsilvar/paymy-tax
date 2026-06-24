-- CreateTable
CREATE TABLE "paystack_webhook_events" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "reference" TEXT,
    "signature" TEXT NOT NULL,
    "raw_body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "paystack_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "paystack_webhook_events_reference_idx" ON "paystack_webhook_events"("reference");

-- CreateIndex
CREATE INDEX "paystack_webhook_events_status_idx" ON "paystack_webhook_events"("status");

-- CreateIndex
CREATE INDEX "paystack_webhook_events_created_at_idx" ON "paystack_webhook_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "paystack_webhook_events_signature_created_at_idx" ON "paystack_webhook_events"("signature", "created_at");
