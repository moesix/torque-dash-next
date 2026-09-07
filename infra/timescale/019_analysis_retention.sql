-- Analysis retention setting for the app-side Analyses prune job (plan 121).
-- Unlike the Logs hypertable path (TimescaleDB add_retention_policy on
-- retentionEnabled/retentionDays above), Analyses is a plain Postgres table;
-- the app runs a scheduled Analysis.destroy pass reading this column.
-- analysisRetentionDays: nullable integer, valid range 90-365 (NULL = disabled)
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "analysisRetentionDays" INTEGER;
