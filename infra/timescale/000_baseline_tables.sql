-- 000_baseline_tables.sql — the only base table no other migration creates.
-- Sync-first Docker boots created this historically; migrations must be able
-- to create it for sync-less installs. All other tables have owning migrations
-- (Users/Sessions: 013, Vehicles: 009, Analyses: 004, Settings: 002).
-- The hypertable conversion, PK restructure and promoted hot columns live in
-- 001_log_hypertable.sql; this file only supplies the plain table it ALTERs.
CREATE TABLE IF NOT EXISTS "Logs" (
    id SERIAL PRIMARY KEY,
    "sessionId" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    lon DOUBLE PRECISION,
    lat DOUBLE PRECISION,
    values JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "Logs_sessionId_timestamp_idx" ON "Logs" ("sessionId", "timestamp");
