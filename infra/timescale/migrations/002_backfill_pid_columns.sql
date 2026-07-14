-- Backfill engine_rpm and vehicle_speed from the values JSONB column.
-- PID 0x0C = Engine RPM → key "kc" (Torque stores hex keys without leading zero)
-- PID 0x0D = Vehicle Speed → key "kd"
--
-- Idempotent: the WHERE clause ensures only rows that actually HAVE the
-- target keys are updated, so re-running is safe. Rows missing either key
-- keep their current NULL / stale values untouched.
--
-- The CASE WHEN regex guard prevents ::numeric cast failures on any
-- non-numeric JSONB content (e.g. Torque label arrays). Only rows whose
-- kc/kd values are plain numbers are updated.
--
-- Estimate row count before running in prod:
--   SELECT count(*) FROM "Logs" WHERE values ? 'kc' AND values ? 'kd';
UPDATE "Logs"
SET engine_rpm = CASE WHEN (values->>'kc') ~ '^-?\d+(\.\d+)?$' THEN (values->>'kc')::numeric ELSE NULL END,
    vehicle_speed = CASE WHEN (values->>'kd') ~ '^-?\d+(\.\d+)?$' THEN (values->>'kd')::numeric ELSE NULL END
WHERE values ? 'kc' AND values ? 'kd';
