-- 024_session_max_types.sql — retrofit the denormalized max columns to DOUBLE
-- PRECISION. 016 adds them with ADD COLUMN IF NOT EXISTS, which is a no-op on
-- databases where sequelize.sync() already created them from an older model
-- (INTEGER); the current model uses DataTypes.DOUBLE. Re-running a same-type
-- ALTER is a no-op for PostgreSQL's type-change machinery, and Sessions is a
-- small table, so this stays idempotent.
--
-- This file OWNS neither column: it relies on 016 having created them. If 016
-- were skipped or reordered, each ALTER aborts loudly
-- ('column "maxRpm" of relation "Sessions" does not exist'), which is intended
-- — a silent no-op would hide a missing 016.
ALTER TABLE "Sessions" ALTER COLUMN "maxRpm" TYPE DOUBLE PRECISION;
ALTER TABLE "Sessions" ALTER COLUMN "maxSpeed" TYPE DOUBLE PRECISION;
