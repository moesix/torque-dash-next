-- Singleton site settings (id = 1). In production this is the source of truth
-- for global flags; the Settings.getSingleton() model helper findOrCreates /
-- upserts row id=1. Keep the column name camelCase to match the Sequelize model
-- (the project does not set `underscored`, so model field `disableRegistration`
-- maps to column "disableRegistration").

CREATE TABLE IF NOT EXISTS "Settings" (
    id integer PRIMARY KEY,
    "disableRegistration" boolean NOT NULL DEFAULT false,
    "uploadApiToken" text,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure the timestamps exist BEFORE seeding. This file is re-run on every
-- database shape (it was edited after shipping), and a targeted INSERT cannot
-- name a column that is missing — Postgres resolves INSERT target columns at
-- parse time, so a FALSE `WHERE EXISTS (...information_schema...)` guard does
-- NOT avoid the "column ... does not exist" error. These two statements are
-- the same idempotent guarantee 025 makes later; for a pre-#83 table they add
-- the columns (and backfill existing rows) so the seed below can rely on them.
-- For a Sequelize sync()-created table the columns already exist but carry
-- NO database default (the model supplies values), which is why the seed names
-- the timestamps explicitly — omitting them failed the v2.3.2 -> v2.4.0
-- upgrade with a NOT NULL violation. 030 later restores the defaults.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Seed the singleton row so GET /api/settings never 404s before first toggle.
-- Timestamps are named explicitly: sync()-created tables declare them NOT NULL
-- with no DB default. ON CONFLICT keeps the re-run a no-op.
INSERT INTO "Settings" (id, "disableRegistration", "uploadApiToken", "createdAt", "updatedAt")
SELECT 1, false, NULL, NOW(), NOW()
ON CONFLICT (id) DO NOTHING;
