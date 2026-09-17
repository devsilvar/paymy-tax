-- CreateTable
CREATE TABLE IF NOT EXISTS "ai_provider_configs" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "provider" TEXT NOT NULL DEFAULT 'groq',
    "name" TEXT NOT NULL DEFAULT 'Groq Cloud',
    "base_url" TEXT NOT NULL DEFAULT 'https://api.groq.com/openai/v1',
    "api_key_encrypted" TEXT,
    "model" TEXT NOT NULL DEFAULT 'qwen/qwen3.8-27b',
    "temperature" DECIMAL(3,2) NOT NULL DEFAULT 0.30,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

-- Insert default row if not exists
INSERT INTO "ai_provider_configs" ("id", "provider", "name", "base_url", "model", "temperature", "max_tokens", "is_active", "updated_at")
VALUES ('default', 'groq', 'Groq Cloud', 'https://api.groq.com/openai/v1', 'qwen/qwen3.8-27b', 0.30, 1024, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
