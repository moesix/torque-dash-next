-- Data retention settings for the Logs hypertable.
-- retentionEnabled: boolean toggle (default false — opt-in)
-- retentionDays: integer, valid range 90-365 (default 365)
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "retentionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "retentionDays" INTEGER NOT NULL DEFAULT 365;
