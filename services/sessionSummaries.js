/**
 * Denormalized session-summary seam (plans/017 — audit TD-01).
 *
 * A session's start/end timestamps and max speed/RPM live in two places:
 *   - the denormalized `Sessions` columns (firstTimestamp/lastTimestamp/
 *     maxRpm/maxSpeed), written by `recomputeSummary`, and
 *   - the `Logs` aggregate over the same rows, used as the fallback for
 *     sessions whose denormalized columns are still NULL.
 *
 * Before this module the min/max aggregate was written twice (a `findAll`
 * GROUP BY fallback in the controller plus a `findOne` recompute). Both copies
 * now share ONE definition of the aggregate (`aggregateAttributes`) and ONE
 * row normalizer (`summaryFromAggregateRow`), so a column/filter change cannot
 * land on one side only.
 *
 * Contracts preserved from the controller copies:
 *  - `aggregateSummaries` keeps the denormalized fast path: the Log scan runs
 *    ONLY for ids whose `firstTimestamp` is NULL, never on the list path.
 *  - `recomputeSummary` stays the SOLE writer of the denormalized columns.
 *  - Query shapes stay as they were: one grouped query for the batched list
 *    fallback, one aggregate `findOne` for the single-session writer (the
 *    list path must not re-scan Logs per session).
 *
 * Models are resolved lazily on each call: the test suites inject a mocked
 * `../models` into require.cache and re-require the controller (the pattern
 * this module inherited), so a module-load-time binding would go stale.
 */

const { invalidatePidKeys } = require('../lib/pidRegistry');
const { formatDuration } = require('../lib/csvExport');

function models() {
    return require('../models');
}

/** The shared min/max aggregate: the SQL column set is defined exactly once. */
function aggregateAttributes() {
    const { sequelize } = models();
    return [
        [sequelize.fn('min', sequelize.col('timestamp')), 'start'],
        [sequelize.fn('max', sequelize.col('timestamp')), 'end'],
        [sequelize.fn('max', sequelize.col('vehicle_speed')), 'maxSpeed'],
        [sequelize.fn('max', sequelize.col('engine_rpm')), 'maxRpm'],
    ];
}

/**
 * Normalize one aggregate row (raw object, Sequelize instance, or a test
 * double's `{ dataValues }`) into the summary shape. Keeps the historical
 * null semantics: timestamps `|| null`, maxima preserved as-is including 0.
 */
function summaryFromAggregateRow(row) {
    const d = row && row.dataValues ? row.dataValues : row;
    return {
        start: d.start || null,
        end: d.end || null,
        maxSpeed: d.maxSpeed != null ? d.maxSpeed : null,
        maxRpm: d.maxRpm != null ? d.maxRpm : null,
    };
}

/**
 * Batched Log aggregate for the list/single-read fallback: one GROUP BY query
 * for every id whose denormalized columns are missing. Returns a Map of
 * sessionId -> { start, end, maxSpeed, maxRpm }; ids with no Log rows are
 * absent from the map.
 */
async function loadAggregateRanges(sessionIds) {
    const { Log } = models();
    const rows = await Log.findAll({
        where: { sessionId: sessionIds },
        attributes: ['sessionId', ...aggregateAttributes()],
        group: ['sessionId'],
    });

    const map = new Map();
    for (const row of rows) {
        const d = row && row.dataValues ? row.dataValues : row;
        map.set(d.sessionId, summaryFromAggregateRow(row));
    }
    return map;
}

/** Single-session Log aggregate for `recomputeSummary` (raw: true, as before). */
async function loadAggregateRange(sessionId) {
    const { Log } = models();
    const row = await Log.findOne({
        where: { sessionId },
        attributes: aggregateAttributes(),
        raw: true,
    });
    return row ? summaryFromAggregateRow(row) : null;
}

/**
 * Aggregated session summary (start/end time + max speed/RPM) for a batch of
 * session ids. Reads the denormalized `Sessions` columns first and falls back
 * to the grouped Log aggregate only for the ids that are still NULL.
 */
async function aggregateSummaries(sessionIds) {
    const map = new Map();
    if (!sessionIds || sessionIds.length === 0) return map;

    const { Session } = models();
    // Read denormalized columns from Session first
    const sessions = await Session.findAll({
        where: { id: sessionIds },
        attributes: ['id', 'firstTimestamp', 'lastTimestamp', 'maxRpm', 'maxSpeed'],
        raw: true,
    });

    const missingIds = [];
    for (const s of sessions) {
        if (s.firstTimestamp != null) {
            map.set(s.id, {
                start: s.firstTimestamp,
                end: s.lastTimestamp,
                maxSpeed: s.maxSpeed,
                maxRpm: s.maxRpm,
            });
        } else {
            missingIds.push(s.id);
        }
    }

    // Fallback to Log aggregate for sessions with NULL denormalized columns
    if (missingIds.length > 0) {
        const fallback = await loadAggregateRanges(missingIds);
        for (const [id, summary] of fallback) {
            map.set(id, summary);
        }
    }
    return map;
}

/** Attach the computed summary fields to a Session (instance or JSON). */
function decorateWithSummaries(session, summary) {
    const out = session.toJSON ? session.toJSON() : session;
    out.startDate = summary.start || null;
    out.endDate = summary.end || null;
    out.duration = formatDuration(summary.start, summary.end);
    out.maxSpeed = summary.maxSpeed ?? null;
    out.maxRpm = summary.maxRpm ?? null;
    return out;
}

/**
 * Recompute and persist one session's denormalized summary columns. Sole
 * writer of the columns; called after every Log mutation (cut/filter/copy/join).
 */
async function recomputeSummary(sessionId) {
    if (!sessionId) return;
    // Drop the cached PID key-set BEFORE reading the aggregate: cut/filter can
    // remove every row, in which case the cache is the most wrong (it still
    // carries PIDs that no longer exist) and the early return below would skip
    // invalidation entirely.
    invalidatePidKeys(sessionId);
    const log = await loadAggregateRange(sessionId);
    if (!log) return;
    const { Session } = models();
    await Session.update(
        {
            firstTimestamp: log.start || null,
            lastTimestamp: log.end || null,
            maxRpm: log.maxRpm ?? null,
            maxSpeed: log.maxSpeed ?? null,
        },
        { where: { id: sessionId } }
    );
}

module.exports = {
    aggregateSummaries,
    decorateWithSummaries,
    recomputeSummary,
    loadAggregateRanges,
    loadAggregateRange,
    summaryFromAggregateRow,
    aggregateAttributes,
};
