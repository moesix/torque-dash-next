CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. Restructure PK: time column must be in the PK.
--    Keep `id` globally unique for id-based ops (filter/cut/join).
ALTER TABLE "Logs" DROP CONSTRAINT "Logs_pkey";
CREATE UNIQUE INDEX logs_id_uidx ON "Logs"(id);
ALTER TABLE "Logs" ADD PRIMARY KEY ("sessionId", timestamp);

-- 2. Explicit dedupe constraint (helps bulkCreate ON CONFLICT + clarity)
ALTER TABLE "Logs" ADD CONSTRAINT logs_session_timestamp_uniq UNIQUE ("sessionId", timestamp);

-- 3. Promoted hot columns (populated at ingest + backfilled)
ALTER TABLE "Logs" ADD COLUMN IF NOT EXISTS "engine_rpm" double precision;
ALTER TABLE "Logs" ADD COLUMN IF NOT EXISTS "vehicle_speed" double precision;

-- 4. Hypertable (migrate existing data; run in a maintenance window)
SELECT create_hypertable('"Logs"', 'timestamp',
       chunk_time_interval => INTERVAL '1 day',
       migrate_data => true);

-- 5. Index for the dominant access pattern
CREATE INDEX IF NOT EXISTS logs_session_time_idx ON "Logs" ("sessionId", timestamp DESC);

-- 6. Continuous aggregate over promoted columns (safe; backfilled)
CREATE MATERIALIZED VIEW IF NOT EXISTS log_1min
WITH (timescaledb.continuous) AS
SELECT "sessionId",
       time_bucket('1 minute', timestamp) AS bucket,
       avg("engine_rpm")    AS avg_rpm,
       max("engine_rpm")    AS max_rpm,
       avg("vehicle_speed") AS avg_speed_kmh,
       max("vehicle_speed") AS max_speed_kmh,
       count(*)             AS n
FROM "Logs"
GROUP BY "sessionId", bucket;

SELECT add_continuous_aggregate_policy('log_1min',
       start_offset => INTERVAL '10 minutes',
       end_offset   => INTERVAL '1 minute',
       schedule_interval => INTERVAL '1 minute');
