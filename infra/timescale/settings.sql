-- Singleton site settings (id = 1). In production this is the source of truth
-- for global flags; the Settings.getSingleton() model helper findOrCreates /
-- upserts row id=1. Keep the column name camelCase to match the Sequelize model
-- (the project does not set `underscored`, so model field `disableRegistration`
-- maps to column "disableRegistration").

CREATE TABLE IF NOT EXISTS "Settings" (
    id integer PRIMARY KEY,
    "disableRegistration" boolean NOT NULL DEFAULT false
);

-- Seed the singleton row so GET /api/settings never 404s before first toggle.
INSERT INTO "Settings" (id, "disableRegistration") VALUES (1, false)
    ON CONFLICT (id) DO NOTHING;
