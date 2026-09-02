-- AlterEnum (idempotent — IF NOT EXISTS for enum values)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'cash'
                 AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SalesSource')) THEN
    ALTER TYPE "SalesSource" ADD VALUE 'cash';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'invoice'
                 AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SalesSource')) THEN
    ALTER TYPE "SalesSource" ADD VALUE 'invoice';
  END IF;
END $$;
