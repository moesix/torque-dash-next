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

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — analyses are small TEXT rows
let started = false;

/** One prune pass: delete analyses older than the configured retention, if enabled. */
async function pruneAnalysesOnce() {
  try {
    const settings = await Settings.getSingleton();
    const days = settings.analysisRetentionDays;
    if (!days || days <= 0) return { pruned: 0, enabled: false };
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { rowsDeleted } = await Analysis.destroy({
      where: { createdAt: { [require('sequelize').Op.lt]: cutoff } },
    });
    return { pruned: rowsDeleted ?? 0, enabled: true };
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

module.exports = { pruneAnalysesOnce, startAnalysesPruner, CHECK_INTERVAL_MS };
