'use strict';

/**
 * In-process operator status collectors (plan 019, DIR-03).
 *
 * Every collector is wrapped in its OWN try/catch: a failed probe nulls only
 * that block (and sets a sibling `<block>Error: true`) — it must never make the
 * whole `/api/status` request fail. `collectStatus` therefore never throws.
 *
 * The response deliberately carries only version/uptime/node, ingest buffer
 * depth, retention policy presence and Timescale job state. No tokens, LLM
 * keys, env values or `Settings.uploadApiToken` are ever read into it.
 */

function defaultDeps() {
    return {
        Settings: require('../models').Settings,
        ingestBuffer: require('./ingestBuffer'),
        analysesRetention: require('./analysesRetention'),
    };
}

async function guarded(status, key, fn) {
    try {
        status[key] = await fn();
    } catch (err) {
        status[key] = null;
        status[`${key}Error`] = true;
        console.error(`[status] ${key} collector failed:`, err.message);
    }
}

async function collectStatus(sequelize, deps) {
    const d = deps || defaultDeps();

    let version = 'unknown';
    try {
        version = require('../package.json').version;
    } catch (err) {
        console.error('[status] package.json version lookup failed:', err.message);
    }

    const status = {
        version,
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
    };

    await guarded(status, 'ingest', async () => ({
        bufferSize: d.ingestBuffer.size(),
        flushing: d.ingestBuffer.isFlushing(),
    }));

    await guarded(status, 'analysesRetention', async () => {
        const last = d.analysesRetention.getLastRun();
        if (!last) return null;
        return {
            lastRunAt: last.at,
            pruned: last.pruned,
            enabled: last.enabled,
        };
    });

    await guarded(status, 'retention', async () => {
        const settings = await d.Settings.getSingleton();
        const enabled = Boolean(settings.retentionEnabled);
        const days = settings.retentionDays ?? null;

        // Policy-job presence is a Timescale-only probe. A failure here (plain
        // Postgres, restricted role) is reported as null rather than nulling
        // the whole retention block — the policy settings are still useful.
        let policyJobPresent = null;
        try {
            const rows = await sequelize.query(
                `SELECT 1 FROM timescaledb_information.jobs
                 WHERE proc_name = 'policy_retention' AND hypertable_name = 'Logs'
                 LIMIT 1`,
                { type: sequelize.QueryTypes.SELECT }
            );
            policyJobPresent = Array.isArray(rows) && rows.length > 0;
        } catch (err) {
            console.error('[status] retention policy job probe failed:', err.message);
        }

        return { enabled, days, policyJobPresent };
    });

    await guarded(status, 'timescale', async () => {
        const extensionRows = await sequelize.query(
            `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb' LIMIT 1`,
            { type: sequelize.QueryTypes.SELECT }
        );
        const jobRows = await sequelize.query(
            `SELECT j.job_id,
                    j.schedule_interval::text AS schedule_interval,
                    s.last_run_status
             FROM timescaledb_information.jobs j
             LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
             ORDER BY j.job_id`,
            { type: sequelize.QueryTypes.SELECT }
        );

        const extensionVersion = Array.isArray(extensionRows) && extensionRows[0]
            ? extensionRows[0].extversion
            : null;

        return {
            extensionVersion,
            jobs: (Array.isArray(jobRows) ? jobRows : []).map((row) => ({
                jobId: row.job_id,
                scheduleInterval: row.schedule_interval,
                lastRunStatus: row.last_run_status,
            })),
        };
    });

    return status;
}

module.exports = { collectStatus };
