-- 000_users_sessions_baseline.sql — ordering baseline for fresh installs.
-- Sorts after 000_baseline_tables.sql (Logs) and before 001: 001 ALTERs Logs
-- and 004 adds foreign keys to Sessions/Users, so both tables must exist
-- before either file runs. The table DDL below is the same as
-- 013_users_sessions_baseline.sql; 013 still runs (and no-ops on fresh
-- databases) and remains untouched for pre-existing ones.
-- Every statement is guarded, so re-running this file is safe.

-- Users table (matches models/User.js)
CREATE TABLE IF NOT EXISTS "Users" (
    id SERIAL PRIMARY KEY,
    email VARCHAR NOT NULL,
    password VARCHAR NOT NULL,
    "forwardUrls" TEXT[],
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraints via CREATE INDEX (avoids collisions with sync-created indexes)
CREATE UNIQUE INDEX IF NOT EXISTS "Users_email_key" ON "Users" (email);

-- Sessions table (matches models/Session.js)
CREATE TABLE IF NOT EXISTS "Sessions" (
    id SERIAL PRIMARY KEY,
    "sessionId" VARCHAR,
    name VARCHAR(255) NOT NULL DEFAULT 'Unnamed session',
    "startLocation" VARCHAR DEFAULT '-',
    "endLocation" VARCHAR DEFAULT '-',
    notes TEXT,
    "vehicleId" INTEGER,
    "userId" INTEGER REFERENCES "Users"(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ
);

-- Unique constraint on sessionId
CREATE UNIQUE INDEX IF NOT EXISTS "Sessions_sessionId_key" ON "Sessions" ("sessionId");

-- Logs.sessionId must not orphan telemetry when a session is deleted. This is
-- the constraint sequelize.sync() creates on sync-first databases (name
-- verified as Logs_sessionId_fkey, ON DELETE CASCADE), so on those the
-- statement is a benign "already exists" skip. On fresh databases the table
-- is empty at this point (000 created it), so the validating scan costs
-- nothing and no NOT VALID staging is needed.
ALTER TABLE "Logs" ADD CONSTRAINT "Logs_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Sessions"(id) ON DELETE CASCADE;
