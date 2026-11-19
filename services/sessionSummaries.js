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
 * There are exactly TWO writers of the denormalized columns, and both live in
 * this module:
 *  - `mergeWrittenRows` — ingest-side, monotonic: one UPDATE per flushed
 *    session using LEAST/GREATEST, so it can only widen the window and raise
 *    the maxima. It never reads the row first (no read-modify-write, so it
 *    cannot resurrect pre-delete values).
 *  - `recomputeSummary` — authoritative: recomputes from `Logs` after every
 *    cut/filter/copy/join.
 * Both run through `withSummaryWriteLock`, which serializes them within this
 * process.
 *
 * Contracts preserved from the controller copies:
 *  - `aggregateSummaries` keeps the denormalized fast path: the Log scan runs
 *    ONLY for ids whose `firstTimestamp` is NULL, never on the list path.
 *  - Query shapes stay as they were: one grouped query for the batched list
 *    fallback, one aggregate `findOne` for the single-session writer (the
 *    list path must not re-scan Logs per session).
 *
 * Models and the PID-key registry are bound once at load time: a test that
 * injects a mocked `../models` must purge this module (see
 * test/support/loadWithMocks.js) so the mock is what gets bound.
 */

const { formatDuration } = require('../lib/csvExport');
const modelsModule = require('../models');
const pidRegistry = require('../lib/pidRegistry');

function models() {
    return modelsModule;
}

// internal — exported for tests
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

// internal — exported for tests
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

// internal — exported for tests
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

// internal — exported for tests
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
 *
 * `preloadedRows` (optional) are Sessions rows the caller has already loaded
 * (instances or plain objects): when given, they replace the summary `SELECT`,
 * so the list/detail paths never re-read the rows they just fetched. They MUST
 * carry `id`, `firstTimestamp`, `lastTimestamp`, `maxRpm`, `maxSpeed` — the
 * list/detail queries select every Sessions column. Behaviour is otherwise
 * identical: NULL-summary rows still go through `loadAggregateRanges`.
 */
async function aggregateSummaries(sessionIds, preloadedRows) {
    const map = new Map();
    if (!sessionIds || sessionIds.length === 0) return map;

    let sessions;
    if (preloadedRows) {
        sessions = preloadedRows.map(s => (typeof s.toJSON === 'function' ? s.toJSON() : s));
    } else {
        const { Session } = models();
        // Read denormalized columns from Session first
        sessions = await Session.findAll({
            where: { id: sessionIds },
            attributes: ['id', 'firstTimestamp', 'lastTimestamp', 'maxRpm', 'maxSpeed'],
            raw: true,
        });
    }

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

// Serializes summary writers within this process. ingest merges and
// recompute-from-Logs both mutate the same four columns; without this, a flush
// that read the pre-delete maxima can write them back after a cut/filter
// recompute. Single-instance deployment is the supported topology (see
// docker-compose.yml); a multi-instance deployment would need a DB-level guard.
let summaryWriteChain = Promise.resolve();
function withSummaryWriteLock(fn) {
    const run = summaryWriteChain.then(fn, fn);
    summaryWriteChain = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * Merge rows that were just written to Logs into the denormalized columns.
 * Monotonic in one SQL statement (no read-modify-write): LEAST/GREATEST can
 * only widen the window and raise the maxima. Called by ingestBuffer after a
 * successful flush; recomputeSummary remains the from-scratch writer.
 *
 * `rows` have the written-Log shape `{ timestamp, engine_rpm, vehicle_speed }`
 * with nullable values. A column whose batch contributes nothing (every value
 * null) is omitted from the SET clause entirely, so it is never cleared.
 */
async function mergeWrittenRows(sessionId, rows) {
    if (!sessionId || !rows || rows.length === 0) return;

    let minTs;
    let maxTs;
    let maxRpm;
    let maxSpeed;
    for (const r of rows) {
        if (r.timestamp != null) {
            if (minTs === undefined || r.timestamp < minTs) minTs = r.timestamp;
            if (maxTs === undefined || r.timestamp > maxTs) maxTs = r.timestamp;
        }
        if (r.engine_rpm != null && (maxRpm === undefined || r.engine_rpm > maxRpm)) {
            maxRpm = r.engine_rpm;
        }
        if (r.vehicle_speed != null && (maxSpeed === undefined || r.vehicle_speed > maxSpeed)) {
            maxSpeed = r.vehicle_speed;
        }
    }

    const setFragments = [];
    const replacements = { id: sessionId };
    if (minTs !== undefined) {
        setFragments.push('"firstTimestamp" = LEAST(COALESCE("firstTimestamp", :minTs), :minTs)');
        replacements.minTs = minTs;
    }
    if (maxTs !== undefined) {
        setFragments.push('"lastTimestamp" = GREATEST(COALESCE("lastTimestamp", :maxTs), :maxTs)');
        replacements.maxTs = maxTs;
    }
    if (maxRpm !== undefined) {
        setFragments.push('"maxRpm" = GREATEST(COALESCE("maxRpm", :maxRpm), :maxRpm)');
        replacements.maxRpm = maxRpm;
    }
    if (maxSpeed !== undefined) {
        setFragments.push('"maxSpeed" = GREATEST(COALESCE("maxSpeed", :maxSpeed), :maxSpeed)');
        replacements.maxSpeed = maxSpeed;
    }
    if (setFragments.length === 0) return;

    const sql = `UPDATE "Sessions" SET ${setFragments.join(', ')} WHERE id = :id`;
    await withSummaryWriteLock(() =>
        models().sequelize.query(sql, { replacements })
    );
}

/**
 * Recompute and persist one session's denormalized summary columns from the
 * `Logs` aggregate. Authoritative writer: called after every Log mutation
 * (cut/filter/copy/join). Ingest merges monotonically through
 * `mergeWrittenRows`; both are serialized by `withSummaryWriteLock`.
 */
async function recomputeSummary(sessionId) {
    if (!sessionId) return;
    await withSummaryWriteLock(async () => {
        // Cut/filter can remove every row, in which case the cache is the most
        // wrong (it still carries PIDs that no longer exist) and the early
        // return below would skip invalidation entirely.
        pidRegistry.invalidatePidKeys(sessionId);
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
    });
}

module.exports = {
    aggregateSummaries,
    decorateWithSummaries,
    recomputeSummary,
    mergeWrittenRows,
    withSummaryWriteLock,
    loadAggregateRanges,
    loadAggregateRange,
    summaryFromAggregateRow,
    aggregateAttributes,
};
