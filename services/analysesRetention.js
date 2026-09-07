/**
 * App-side scheduled prune job for stale Analysis rows (plan 121, option A).
 *
 * `Analyses` is a plain Postgres table — no hypertable, so no TimescaleDB
 * native retention policy. Session logs expire underneath it via the Logs
 * hypertable policy (retentionEnabled/retentionDays in Settings), leaving
 * stale analyses to orphan the cross-vehicle history view. This job sweeps
 * Analysis rows older than a configurable `analysisRetentionDays` setting.
 *
 * Semantics:
 *  - NULL/<=0 analysisRetentionDays ⇒ disabled (no-op pass).
 *  - Retention is a GLOBAL operator setting; the sweep destroys across ALL
 *    users (never scoped to the current user) — same contract as the Logs
 *    policy.
 *  - The sweep runs in BOUNDED id batches (BATCH_SIZE) so one oversized
 *    DELETE never holds a transaction/lock for the whole stale set. Rows are
 *    selected oldest-first by id (ASC, keyset over the createdAt-capped
 *    id-ordered set — see migration 017) and destroyed by id IN (...); the
 *    loop stops as soon as a batch comes back short.
 *  - A successful non-zero pass is logged at INFO level with the [analysesRetention]
 *    prefix (matching the existing console.error style used for failures).
 *  - A failed pass must never take the app down: errors are caught, logged
 *    with the [analysesRetention] prefix, and returned in the result object.
 *
 * The recurring timer is unref'd so it never holds the process open on its
 * own (matches services/ingestBuffer.js). `started` makes startAnalysesPruner
 * idempotent — a second call returns null instead of stacking timers, which
 * keeps test suites that boot the app multiple times safe.
 */
const Analysis = require('../models').Analysis;
const Settings = require('../models').Settings;
const { Op } = require('sequelize');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — analyses are small TEXT rows
const BATCH_SIZE = 5000;
let started = false;

/**
 * One prune pass: delete analyses older than the configured retention, in
 * bounded batches. Resolves { pruned, enabled } and never throws.
 */
async function pruneAnalysesOnce() {
  try {
    const settings = await Settings.getSingleton();
    const days = settings.analysisRetentionDays;
    if (!days || days <= 0) return { pruned: 0, enabled: false };
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let pruned = 0;
    while (true) {
      // Id-ASC keyset over the stale set — bounded read, then destroy by id.
      const staleRows = await Analysis.findAll({
        where: { createdAt: { [Op.lt]: cutoff } },
        attributes: ['id'],
        order: [['id', 'ASC']],
        limit: BATCH_SIZE,
      });
      if (staleRows.length === 0) break;
      const ids = staleRows.map((r) => r.id);
      // Model.destroy() on Postgres resolves to the affected row count.
      const destroyed = await Analysis.destroy({ where: { id: { [Op.in]: ids } } });
      pruned += Number.isFinite(destroyed) ? destroyed : ids.length;
      if (staleRows.length < BATCH_SIZE) break; // short batch ⇒ no more stale rows
    }

    if (pruned > 0) {
      console.log(
        `[analysesRetention] pruned ${pruned} analyses older than ${cutoff.toISOString()}`,
      );
    }
    return { pruned, enabled: true };
  } catch (err) {
    // A prune failure must never take the app down.
    console.error('[analysesRetention] prune pass failed:', err.message);
    return { pruned: 0, enabled: false, error: err.message };
  }
}

/** Start the recurring pruner (idempotent; unref so it never holds the process open). */
function startAnalysesPruner(ms = CHECK_INTERVAL_MS) {
  if (started) return null;
  started = true;
  const handle = setInterval(() => { pruneAnalysesOnce().catch(() => {}); }, ms);
  handle.unref?.();
  return handle;
}

module.exports = { pruneAnalysesOnce, startAnalysesPruner, CHECK_INTERVAL_MS, BATCH_SIZE };
