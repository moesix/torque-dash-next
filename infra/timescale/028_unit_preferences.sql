-- Per-user display preference. Values are display-time only; telemetry stays
-- canonical (km/h, °C, kPa, L). NULL = follow DEFAULT_UNIT_SYSTEM (env).
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "unitSystem" VARCHAR(16) NULL;

-- Descriptive metadata for stored analysis prose: the units it was generated
-- in. NULL = unknown (historical rows). Not used for rendering the prose.
ALTER TABLE "Analyses" ADD COLUMN IF NOT EXISTS "unitSystem" VARCHAR(16) NULL;

-- The migration runner splits on ';' (no dollar-quote awareness), so use a
-- plain ADD CONSTRAINT: a re-run hits Postgres' "already exists" error, which
-- scripts/migrate.js treats as a benign idempotent skip.
ALTER TABLE "Users" ADD CONSTRAINT "Users_unitSystem_check"
  CHECK ("unitSystem" IS NULL OR "unitSystem" IN ('metric','us','uk'));
