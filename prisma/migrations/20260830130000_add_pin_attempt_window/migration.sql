-- AlterTable (idempotent)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'users' AND column_name = 'pin_attempts_reset_at') THEN
    ALTER TABLE "users" ADD COLUMN "pin_attempts_reset_at" TIMESTAMP(3);
  END IF;
END $$;
