-- log_1min had no consumer; its refresh policy costs write amplification
-- against the hypertable with no reader. A future overview feature should
-- define a new CAGG sized to that feature, not resurrect this one.
-- `if_exists => true` alone is NOT enough to survive a re-run: the regclass
-- argument is resolved at plan time, before the function executes, so a
-- missing `log_1min` relation raises "relation does not exist". The
-- `to_regclass(...) IS NOT NULL` guard (to_regclass returns NULL instead of
-- erroring) is what makes a tracker reset / manual CAGG drop safe.
SELECT remove_continuous_aggregate_policy(to_regclass('log_1min'), if_exists => true)
WHERE to_regclass('log_1min') IS NOT NULL;
DROP MATERIALIZED VIEW IF EXISTS log_1min;
