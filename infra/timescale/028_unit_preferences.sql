-- Per-user display preference. Values are display-time only; telemetry stays
-- canonical (km/h, °C, kPa, L). NULL = follow DEFAULT_UNIT_SYSTEM (env).
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "unitSystem" VARCHAR(16) NULL;

-- Descriptive metadata for stored analysis prose: the units it was generated
-- in. NULL = unknown (historical rows). Not used for rendering the prose.
ALTER TABLE "Analyses" ADD COLUMN IF NOT EXISTS "unitSystem" VARCHAR(16) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Users_unitSystem_check') THEN
    ALTER TABLE "Users" ADD CONSTRAINT "Users_unitSystem_check"
      CHECK ("unitSystem" IS NULL OR "unitSystem" IN ('metric','us','uk'));
  END IF;
END $$;
