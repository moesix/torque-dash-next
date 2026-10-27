-- 000_baseline_tables.sql — the only base table no other migration creates.
-- Sync-first Docker boots created this historically; migrations must be able
-- to create it for sync-less installs. All other tables have owning migrations
-- (Users/Sessions: 013, Vehicles: 009, Analyses: 004, Settings: 002).
-- The hypertable conversion, PK restructure, promoted hot columns and the
-- ("sessionId", "timestamp") index live in 001_log_hypertable.sql; this file
-- only supplies the plain table it ALTERs. Do NOT add indexes here: 001 already
-- indexes those columns, and a second index would be built non-concurrently on
-- the hottest table of existing deployments.
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
