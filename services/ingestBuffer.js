/**
 * Buffered, batched ingestion for Log rows (Tier-2 optimization).
 *
 * Rows are accumulated in memory and flushed to the DB either when the buffer
 * reaches BATCH_SIZE or every FLUSH_MS via a timer (unref'd so it never keeps
 * the event loop alive on its own). The buffer stores only RESOLVED numeric FKs
 * (userId, sessionId) — never emails.
 *
 * Failure semantics: failures are isolated per chunk. A failed chunk is
 * re-queued with an attempt counter; when rows that already burned a retry fail
 * again, the chunk is bisected so one bad row cannot discard its healthy
 * chunk-mates. Rows are dropped (and logged) after MAX_RETRIES, which bounds
 * memory growth at the cost of possible telemetry loss on a persistently
 * failing DB — acknowledge this in ops runbooks.
 *
 * Log-mutating callers (session delete/cut/filter/copy/join, and any future
 * bulk import or retention sweep) MUST `await drain()` first: buffered frames
 * would otherwise land after the mutation and resurrect deleted ranges.
 */
const Log = require('../models').Log;
// pidRegistry has no heavy deps and does not require models — no cycle.
const { invalidatePidKeys } = require('../lib/pidRegistry');
// sessionSummaries resolves models lazily, so requiring it here is cycle-safe.
const { mergeWrittenRows } = require('./sessionSummaries');

const BATCH_SIZE = 1000;
const FLUSH_MS = 1000;
const MAX_RETRIES = 3;
const MAX_BUFFER_SIZE = 50000; // drop oldest rows if exceeded
// Upper bound on the bulkCreate calls ONE flush may spend isolating failing
// rows (both bisection halves are counted, so the pass never exceeds this).
// Without it a wholesale DB outage — every chunk failing again after its first
// retry, so every chunk eligible for bisection — would turn one flush into
// thousands of doomed queries. The budget is global per flush (not per chunk):
// once it is spent, the rest of that pass re-queues wholesale with the attempt
// counters advanced normally. It resets on the next pass, so isolation
// self-heals across flushes — later chunks simply wait for a later pass.
const MAX_ISOLATION_ATTEMPTS = 64;

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
let currentFlushPromise = null;

// Put a failed subset back at the FRONT of the buffer. Only these rows advance
// the retry counter; rows that were written never touch it.
function requeue(items) {
    for (const item of items) {
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
}

async function writeBatch(items) {
    await Log.bulkCreate(items.map(toLogRow), { ignoreDuplicates: true, returning: false });
}

// Re-queue a failed subset, bisecting it first when (a) it holds more than one
// row, (b) its rows already failed at least once (the first failure re-queues
// the whole chunk, giving the DB a chance to recover), and (c) the per-flush
// isolation budget allows it. Recursion reaches single rows, so a lone bad row
// is the only one that keeps advancing its counter.
async function requeueOrBisect(items, written, state) {
    const retried = items.some((item) => (item.__attempts || 0) >= 1);
    if (items.length > 1 && retried && state.isolationAttempts + 2 <= MAX_ISOLATION_ATTEMPTS) {
        state.isolationAttempts += 2; // the two halves about to be attempted
        const mid = Math.ceil(items.length / 2);
        await writeSubset(items.slice(0, mid), written, state);
        await writeSubset(items.slice(mid), written, state);
        return;
    }
    requeue(items);
}

async function writeSubset(items, written, state) {
    try {
        await writeBatch(items);
        for (const item of items) written.push(item);
    } catch {
        await requeueOrBisect(items, written, state);
    }
}

async function writeChunk(items, written, state) {
    try {
        await writeBatch(items);
        for (const item of items) written.push(item);
    } catch (err) {
        const sidList = [...new Set(items.map(i => i.sessionId))].join(',');
        console.error(`[ingestBuffer] chunk write failed (sessions: ${sidList}), re-queueing:`, err.message);
        await requeueOrBisect(items, written, state);
    }
}

async function runFlush() {
    const batch = buffer.splice(0, buffer.length); // synchronous snapshot
    const written = []; // rows that actually reached the DB in this pass
    const state = { isolationAttempts: 0 };

    // Flush in chunks of at most BATCH_SIZE to avoid exceeding the
    // PostgreSQL parameter limit (typically 32767 bind params).
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
        await writeChunk(batch.slice(i, i + BATCH_SIZE), written, state);
    }

    // Per-chunk success: only sessions whose rows DID land may have derived
    // state advanced. A fully failed flush writes nothing, so it invalidates
    // nothing and merges nothing — that invariant is contractual (see
    // test/pidKeyCache.test.js).
    const writtenRows = written.map(toLogRow);
    for (const sid of new Set(writtenRows.map(r => r.sessionId))) {
        // Discovered PID key-sets are append-mostly: any write may introduce a
        // new key, so drop each written session's cached entry unconditionally.
        // Re-queued or dropped rows wrote nothing and keep their entry valid.
        invalidatePidKeys(sid);
    }

    if (writtenRows.length === 0) return;

    // Merge the successfully-written rows' min/max into the denormalized
    // summary columns so list views read Sessions instead of scanning Logs.
    // One monotonic UPDATE per affected session via the single shared merge
    // path (LEAST/GREATEST in SQL, no read-modify-write, so a flush can never
    // write stale pre-delete maxima back after a cut/filter recompute).
    // Gated on at least one successfully-written chunk: when every Log write
    // failed (rows re-queued or dropped), these Session updates must NOT run —
    // otherwise denormalized summaries would advance AHEAD of the Logs table
    // they derive from.
    let currentSummarySessionId = null;
    try {
        for (const sessionId of new Set(writtenRows.map(r => r.sessionId))) {
            currentSummarySessionId = sessionId;
            await mergeWrittenRows(
                sessionId,
                writtenRows.filter(r => r.sessionId === sessionId)
            );
        }
    } catch (err) {
        console.error(`[ingestBuffer] summary update failed (session: ${currentSummarySessionId ?? 'unknown'}):`, err.message);
    }
}

// Track the in-flight pass so drain() can await it. flush() never rejects:
// failures are handled per chunk inside runFlush().
function flush() {
    if (flushing || buffer.length === 0) return Promise.resolve();
    flushing = true;
    currentFlushPromise = runFlush()
        .catch((err) => console.error('[ingestBuffer] flush error:', err.message))
        .finally(() => {
            flushing = false;
            currentFlushPromise = null;
        });
    return currentFlushPromise;
}

/**
 * Quiesces ingest passes that THIS drain knows about. Drains are serialized
 * through a promise chain, so sibling drain bodies never interleave and no
 * drain resolves while a pass it observed still holds rows in flight.
 *
 * That is the whole contract — it is NOT a write-success signal: rows that
 * could not be written stay queued for the normal retry window (≤ MAX_RETRIES
 * flushes) or are dropped once that window is spent, and an ingest that
 * arrives after this drain returns can start a new pass of its own. Fulfills
 * even on failure — callers must not treat a drained buffer as "everything is
 * in the DB", only as "the passes this drain knew about have settled".
 */
let drainChain = Promise.resolve();
function drain() {
    // Sibling drains execute one at a time. Never call drain() from inside a
    // drain body (self-await) and never from inside flush().
    const run = drainChain.then(async () => {
        while (flushing && currentFlushPromise) await currentFlushPromise;
        if (buffer.length > 0) await flush();
        while (flushing && currentFlushPromise) await currentFlushPromise;
    });
    drainChain = run.then(() => {}, () => {});
    return run;
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
        // fire-and-forget; the request path must NOT await the flush.
        // flush() never rejects: runFlush() handles failures per chunk and the
        // returned promise carries a terminal catch, so no .catch is needed.
        flush();
    }
}

// Observation seam for tests: flush() resolves with no value, so callers (and
// drain tests) need the remaining row count to know the pass completed.
function size() {
    return buffer.length;
}

// Observation seam for the operator status endpoint (plan 019): whether a
// flush pass is currently in flight.
function isFlushing() {
    return flushing;
}

module.exports = { ingest, flush, drain, size, isFlushing };
