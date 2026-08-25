/**
 * Buffered, batched ingestion for Log rows (Tier-2 optimization).
 *
 * Rows are accumulated in memory and flushed to the DB either when the buffer
 * reaches BATCH_SIZE or every FLUSH_MS via a timer (unref'd so it never keeps
 * the event loop alive on its own). The buffer stores only RESOLVED numeric FKs
 * (userId, sessionId) — never emails.
 *
 * Failure semantics: a failed flush re-queues the batch (with an attempt
 * counter) up to MAX_RETRIES times, after which the rows are dropped and an
 * error is logged. This bounds memory growth at the cost of possible telemetry
 * loss on a persistently failing DB — acknowledge this in ops runbooks.
 */
const Log = require('../models').Log;
const Session = require('../models').Session;
// pidRegistry has no heavy deps and does not require models — no cycle.
const { invalidatePidKeys } = require('../lib/pidRegistry');

const BATCH_SIZE = 1000;
const FLUSH_MS = 1000;
const MAX_RETRIES = 3;
const MAX_BUFFER_SIZE = 50000; // drop oldest rows if exceeded

const buffer = [];

function toLogRow(item) {
    return {
        sessionId: item.sessionId,
        timestamp: item.time,
        lon: item.lon,
        lat: item.lat,
        values: item.values,
        engine_rpm: item.engineRpm,
        vehicle_speed: item.vehicleSpeed
        // NOTE: userId is intentionally NOT written to Log (no such column).
    };
}

let flushing = false;

// JS-side LEAST/GREATEST equivalents that COALESCE NULLs (either side null
// yields the other candidate; both non-null yields the min/max).
function minDate(a, b) { if (a == null) return b; if (b == null) return a; return b < a ? b : a; }
function maxDate(a, b) { if (a == null) return b; if (b == null) return a; return b > a ? b : a; }
function maxNum(a, b)  { if (a == null) return b; if (b == null) return a; return b > a ? b : a; }

async function flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, buffer.length); // synchronous snapshot
    try {
        const rows = batch.map(toLogRow);
        // Flush in chunks of at most BATCH_SIZE to avoid exceeding the
        // PostgreSQL parameter limit (typically 32767 bind params).
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const chunk = rows.slice(i, i + BATCH_SIZE);
            await Log.bulkCreate(chunk, { ignoreDuplicates: true, returning: false });
        }
        // Discovered PID key-sets are append-mostly: any write may introduce a
        // new key, so drop each touched session's cached entry unconditionally.
        // Success path only — a failed flush writes nothing and must keep the
        // cache valid.
        for (const sid of new Set(rows.map(r => r.sessionId))) {
            invalidatePidKeys(sid);
        }
    } catch (err) {
        console.error('[ingestBuffer] flush failed, re-queueing:', err.message);
        for (const item of batch) {
            item.__attempts = (item.__attempts || 0) + 1;
            if (item.__attempts <= MAX_RETRIES) {
                buffer.unshift(item);
            } else {
                console.error('[ingestBuffer] dropping row after max retries:', {
                    sessionId: item.sessionId,
                    timestamp: item.time
                });
            }
        }
    } finally {
        flushing = false;
    }

    // Merge this batch's min/max into the denormalized summary columns so
    // list views read Sessions instead of scanning Logs. Values are computed
    // in JS from the batch we already hold and bound as parameters — no SQL
    // aliases, no literal fragments (a previous version referenced a nonexistent
    // "sub" alias and silently failed on every flush). Stats are derived from
    // toLogRow-shaped rows ({ timestamp, engine_rpm, vehicle_speed }) because
    // the raw buffered items use different key names (time/engineRpm/...).
    try {
        const rows = batch.map(toLogRow);
        const stats = new Map(); // sessionId -> {minTs, maxTs, maxRpm, maxSpeed}
        for (const r of rows) {
            let s = stats.get(r.sessionId);
            if (!s) stats.set(r.sessionId, s = {});
            if (r.timestamp != null && (s.minTs === undefined || r.timestamp < s.minTs)) s.minTs = r.timestamp;
            if (r.timestamp != null && (s.maxTs === undefined || r.timestamp > s.maxTs)) s.maxTs = r.timestamp;
            if (r.engine_rpm != null && (s.maxRpm === undefined || r.engine_rpm > s.maxRpm)) s.maxRpm = r.engine_rpm;
            if (r.vehicle_speed != null && (s.maxSpeed === undefined || r.vehicle_speed > s.maxSpeed)) s.maxSpeed = r.vehicle_speed;
        }

        // One update per affected session, merging against current column values.
        // COALESCE handles the NULL (never-backfilled) case; LEAST/GREATEST run
        // in JS because both candidates are known here.
        for (const [sessionId, s] of stats) {
            const existing = await Session.findByPk(sessionId, {
                attributes: ['id', 'firstTimestamp', 'lastTimestamp', 'maxRpm', 'maxSpeed'],
            });
            if (!existing) continue;
            const merged = {
                firstTimestamp: minDate(existing.firstTimestamp, s.minTs),
                lastTimestamp: maxDate(existing.lastTimestamp, s.maxTs),
                maxRpm: maxNum(existing.maxRpm, s.maxRpm ?? null),
                maxSpeed: maxNum(existing.maxSpeed, s.maxSpeed ?? null),
            };
            await Session.update(merged, { where: { id: sessionId } });
        }
    } catch (err) {
        console.error('[ingestBuffer] summary update failed:', err.message);
    }
}

const timer = setInterval(flush, FLUSH_MS);
timer.unref(); // do not keep the process alive solely for flushing

function ingest({ userId, sessionId, time, lon, lat, values, engineRpm, vehicleSpeed }) {
    buffer.push({
        userId, // kept for traceability only; not written to Log
        sessionId,
        time,
        lon,
        lat,
        values,
        engineRpm,
        vehicleSpeed,
        __attempts: 0
    });
    // Drop oldest rows if buffer exceeds cap (backpressure)
    if (buffer.length > MAX_BUFFER_SIZE) {
        const dropped = buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
        console.error('[ingestBuffer] buffer overflow, dropping', dropped.length, 'rows');
    }
    if (buffer.length >= BATCH_SIZE) {
        // fire-and-forget; the request path must NOT await the flush
        flush().catch((e) => console.error('[ingestBuffer] flush error:', e.message));
    }
}

module.exports = { ingest, flush };
