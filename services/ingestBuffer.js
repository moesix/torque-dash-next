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
const sequelize = require('../models').sequelize;

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
        // Flush in chunks of at most BATCH_SIZE to avoid exceeding the
        // PostgreSQL parameter limit (typically 32767 bind params).
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const chunk = rows.slice(i, i + BATCH_SIZE);
            await Log.bulkCreate(chunk, { ignoreDuplicates: true, returning: false });
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

    // Denormalize summary columns on affected sessions using LEAST/GREATEST
    // so concurrent ingests never overwrite a wider range.
    // Runs OUTSIDE the main try/catch so a summary-update failure never
    // re-queues rows that were already successfully written to the Log table.
    try {
        const sessionIds = [...new Set(batch.map(r => r.sessionId))];
        if (sessionIds.length > 0) {
            await Session.update({
                firstTimestamp: sequelize.literal(`LEAST(COALESCE("Sessions"."firstTimestamp", sub.min_ts), sub.min_ts)`),
                lastTimestamp: sequelize.literal(`GREATEST(COALESCE("Sessions"."lastTimestamp", sub.max_ts), sub.max_ts)`),
                maxRpm: sequelize.literal(`GREATEST(COALESCE("Sessions"."maxRpm", sub.max_rpm), sub.max_rpm)`),
                maxSpeed: sequelize.literal(`GREATEST(COALESCE("Sessions"."maxSpeed", sub.max_speed), sub.max_speed)`),
            }, {
                where: { id: sessionIds },
                replacements: {},
            });
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
