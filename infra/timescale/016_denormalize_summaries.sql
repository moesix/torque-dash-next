-- Plan 064: Denormalize session summaries to eliminate per-request full-table scans.
-- Adds summary columns to Sessions so aggregateSummaries can read them directly
-- instead of scanning every frame of every session.

ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "firstTimestamp" TIMESTAMPTZ;
ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "lastTimestamp" TIMESTAMPTZ;
ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "maxRpm" DOUBLE PRECISION;
ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "maxSpeed" DOUBLE PRECISION;

-- Backfill existing sessions (one-time, safe to re-run).
-- Uses WHERE s."firstTimestamp" IS NULL to skip already-populated rows.
UPDATE "Sessions" s SET
    "firstTimestamp" = agg.start_ts,
    "lastTimestamp" = agg.end_ts,
    "maxRpm" = agg.max_rpm,
    "maxSpeed" = agg.max_speed
FROM (
    SELECT "sessionId",
           min(timestamp) as start_ts,
           max(timestamp) as end_ts,
           max(engine_rpm) as max_rpm,
           max(vehicle_speed) as max_speed
    FROM "Logs"
    GROUP BY "sessionId"
) agg
WHERE s.id = agg."sessionId"
  AND s."firstTimestamp" IS NULL;
