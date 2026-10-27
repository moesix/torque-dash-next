'use strict';

// Shared synthetic Torque upload generator. One generator feeds both the
// integration suite (over GET /api/upload) and scripts/seed-demo.js (through
// ingestBuffer), so the wire shape and the buffered row shape cannot drift.
//
// Wire shape mirrors a real Torque Pro GET: every value is a query-string
// scalar. `kc` (PID 0x0C) / `kd` (PID 0x0D) are the promoted engine_rpm /
// vehicle_speed channels, `kff1005` / `kff1006` are GPS longitude / latitude
// (excluded from Logs.values by UploadController), and the remaining k* keys
// land in Logs.values.

const DEFAULT_TIME = Date.UTC(2026, 0, 15, 9, 0, 0);

// Query params UploadController lifts out of `values` (it destructures them
// before buffering), so toIngestItem must strip the same set.
const RESERVED = new Set(['eml', 'v', 'session', 'id', 'time', 'kff1005', 'kff1006']);

/**
 * Build one upload query params object.
 * @param {object} [overrides] any wire param; `t` is the epoch-ms timestamp.
 * @returns {Record<string, string>}
 */
function makeFrame(overrides = {}) {
    const {
        t = DEFAULT_TIME,
        session = 'integration-session',
        eml = 'integration@example.com',
        rpm = 2500,
        speed = 60,
        lat = 45.5017,
        lon = -73.5673,
        bearing = 90,
        ...rest
    } = overrides;

    return {
        eml,
        session,
        time: String(t),
        kff1005: String(lon),
        kff1006: String(lat),
        kff1007: String(bearing),
        kc: String(rpm),
        kd: String(speed),
        k5: '88',
        k11: '22',
        kb: '101',
        ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
    };
}

/**
 * Build a fixed-interval series of frames for one session.
 * @param {object} [opts]
 * @param {number} [opts.count]
 * @param {number} [opts.start] epoch ms of the first frame
 * @param {number} [opts.intervalMs]
 */
function makeSeries({
    count = 5,
    start = DEFAULT_TIME,
    intervalMs = 1000,
    rpmBase = 800,
    speedBase = 20,
    ...frameDefaults
} = {}) {
    return Array.from({ length: count }, (_, i) => makeFrame({
        ...frameDefaults,
        t: start + i * intervalMs,
        // Bounded, repeating variation keeps long demo series realistic
        // (idle-to-redline sweeps instead of a 30,000 rpm ramp).
        rpm: rpmBase + (i % 20) * 250,
        speed: speedBase + (i % 15),
    }));
}

/**
 * Map a wire frame onto the shape ingestBuffer.ingest() accepts, replaying
 * UploadController's coercion (Number on kc/kd/GPS, rest kept raw in `values`).
 * @param {Record<string, string>} frame
 * @param {{ userId: number, sessionId: number }} ids resolved numeric FKs
 */
function toIngestItem(frame, { userId, sessionId }) {
    const values = {};
    for (const [key, value] of Object.entries(frame)) {
        if (!RESERVED.has(key)) values[key] = value;
    }
    const num = (value) => (value != null ? Number(value) : null);
    return {
        userId,
        sessionId,
        time: new Date(Number(frame.time)),
        lon: num(frame.kff1005),
        lat: num(frame.kff1006),
        values,
        engineRpm: num(frame.kc),
        vehicleSpeed: num(frame.kd),
    };
}

module.exports = { makeFrame, makeSeries, toIngestItem, DEFAULT_TIME };
