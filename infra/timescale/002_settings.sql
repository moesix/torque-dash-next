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

-- Seed the singleton row so GET /api/settings never 404s before first toggle.
-- Timestamps are intentionally not named here: this file was edited after
-- shipping, so databases that applied the pre-#83 version re-run it and may not
-- have the columns yet. 025 backfills them.
INSERT INTO "Settings" (id, "disableRegistration", "uploadApiToken") VALUES (1, false, NULL)
    ON CONFLICT (id) DO NOTHING;
