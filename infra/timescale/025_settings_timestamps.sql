-- 025: ensure Settings timestamps exist on databases whose 002 was applied
-- before commit eda8643 added the columns inside CREATE TABLE IF NOT EXISTS.
-- Idempotent; safe on every schema shape.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();
