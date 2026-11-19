-- 003: The nested PID backfill (002) runs AFTER top-level 016 computed the
-- denormalized summaries, so upgraded installs kept maxRpm/maxSpeed computed
-- while engine_rpm/vehicle_speed were still NULL. Re-widen monotonically:
-- LEAST/GREATEST only raise the maxima and extend the window, so a session
-- whose old chunks were already retention-dropped is never regressed.
--
-- ORDERING HAZARD (do not reintroduce): migrate.js sorts migration paths
-- lexicographically, so a file under `migrations/` always runs after every
-- top-level `0NN_*.sql`. This file lives in the nested directory precisely
-- because it must run after 002_backfill_pid_columns.sql. Any future migration
-- that reads columns populated by another nested file must be numbered after
-- it inside this same directory.
UPDATE "Sessions" s
SET "firstTimestamp" = LEAST(COALESCE(s."firstTimestamp", agg.start_ts), agg.start_ts),
    "lastTimestamp"  = GREATEST(COALESCE(s."lastTimestamp", agg.end_ts), agg.end_ts),
    "maxRpm"         = GREATEST(COALESCE(s."maxRpm", agg.max_rpm), agg.max_rpm),
    "maxSpeed"       = GREATEST(COALESCE(s."maxSpeed", agg.max_speed), agg.max_speed)
FROM (
    SELECT "sessionId",
           min(timestamp) AS start_ts,
           max(timestamp) AS end_ts,
           max(engine_rpm) AS max_rpm,
           max(vehicle_speed) AS max_speed
    FROM "Logs"
    GROUP BY "sessionId"
) agg
WHERE s.id = agg."sessionId";
