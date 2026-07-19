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

async function flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, buffer.length); // synchronous snapshot
    try {
        const rows = batch.map(toLogRow);
        await Log.bulkCreate(rows, { ignoreDuplicates: true });
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
