/**
 * Run the TimescaleDB hypertable migration against the configured database.
 *
 * Reads infra/timescale/log_hypertable.sql and executes each statement via the
 * `pg` client. This is idempotent in practice: the SQL guards with IF NOT EXISTS
 * where possible, and statements are executed individually so that benign
 * "already exists" / "does not exist" errors on re-run are tolerated and skipped.
 *
 * This script runs TimescaleDB migrations. In Docker deployments, it is
 * executed automatically at container startup (see Dockerfile CMD). For
 * non-Docker setups, run manually: `node scripts/migrate.js`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const SQL_DIR = path.join(__dirname, '..', 'infra', 'timescale');

// Errors that are safe to ignore when re-running a migration (idempotency).
function isBenignError(err) {
    const msg = (err && err.message) ? err.message : '';
    return (
        /already exists/i.test(msg) ||
        /duplicate.*constraint/i.test(msg) ||
        /multiple primary keys/i.test(msg) ||
        /relation "log_1min" already exists/i.test(msg) ||
        /already a hypertable/i.test(msg) ||
        /operation not supported on hypertables that have compression enabled/i.test(msg) ||
        /cannot disable compression on hypertable with compressed chunks/i.test(msg)
    );
}

/**
 * Strip SQL comments so that semicolons inside block comments (slash-star
 * ... star-slash) or line comments (double-dash) don't fragment the naive
 * ;-split below.  Block comments are stripped first to avoid stripping
 * line-comment syntax that appears inside them.
 */
function stripComments(sql) {
    // Strip /* ... */ block comments (non-greedy, handles multi-line)
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip -- line comments to end of line
    sql = sql.replace(/--[^\n]*/g, '');
    return sql;
}

// Load every *.sql file under the migration directory tree, in lexicographic
// order so e.g. `log_hypertable.sql` (TimescaleDB setup) runs before
// `settings.sql`, and top-level files run before `migrations/*.sql` (paths are
// relative to SQL_DIR, so `migrations/...` sorts after every `0NN_...` file).
function loadStatements() {
    const files = listMigrationFiles();
    const all = [];
    for (const file of files) {
        const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        const clean = stripComments(sql);
        const stmts = clean
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => ({ sql: s + ';', file }));
        all.push(...stmts);
    }
    return all;
}

async function run() {
    const config = require('../config/config');
    const connectionString = process.env.DATABASE_URL || config.db.uri;
    const pool = new Pool({ connectionString });
    try {

    // Ensure the migration tracker exists. This table is managed directly by
    // migrate.js and is intentionally NOT a migration file itself.
    await ensureTrackerTable(pool);

    const statements = loadStatements();
    console.log(`[migrate] Executing ${statements.length} statements across migration files...`);

    // Group statements by their source file, preserving lexicographic order so
    // that a file is only marked applied once ALL of its statements succeed.
    // Seed from the FULL file list first: comment-only files (zero statements
    // after comment stripping, e.g. 012_upload_token.sql) must still appear in
    // filesInOrder so they get recorded in the tracker instead of silently
    // vanishing from bookkeeping.
    const filesInOrder = [];
    const byFile = new Map();
    for (const file of listMigrationFiles()) {
        if (!byFile.has(file)) {
            byFile.set(file, []);
            filesInOrder.push(file);
        }
    }
    for (const st of statements) {
        byFile.get(st.file).push(st);
    }

    let globalIndex = 0;
    for (const file of filesInOrder) {
        const contentHash = hashFileContent(file);
        if (await isFileApplied(pool, file, contentHash)) {
            console.log(`[migrate] SKIP (already applied): ${file}`);
            globalIndex += byFile.get(file).length;
            continue;
        }

        const fileStatements = byFile.get(file);
        for (const { sql: stmt, file: stmtFile } of fileStatements) {
            globalIndex++;
            try {
                await pool.query(stmt);
                console.log(`[migrate] (${globalIndex}/${statements.length}) [${stmtFile}] OK: ${stmt.slice(0, 60).replace(/\s+/g, ' ')}`);
            } catch (err) {
                if (isBenignError(err)) {
                    console.warn(`[migrate] (${globalIndex}/${statements.length}) [${stmtFile}] SKIP (benign): ${err.message}`);
                } else {
                    console.error(`[migrate] (${globalIndex}/${statements.length}) [${stmtFile}] FAILED: ${err.message}`);
                    process.exitCode = 1;
                    return;
                }
            }
        }

        // All statements for this file succeeded (benign skips count as success),
        // so record it. We only insert here — never on a non-benign failure.
        // Upsert on `filename`: makes a concurrent-replica race (both INSERT the
        // same filename) and a future content-edit re-run (new hash, same
        // filename) safe no-ops instead of an uncaught UNIQUE violation.
        await pool.query(
            `INSERT INTO _migrations (filename, content_hash) VALUES ($1, $2)
             ON CONFLICT (filename) DO UPDATE SET content_hash = EXCLUDED.content_hash, applied_at = now()`,
            [file, contentHash]
        );
        console.log(`[migrate] RECORDED: ${file}`);
    }

    console.log('[migrate] Done.');
    } finally {
        await pool.end();
    }
}

/**
 * Create the migration tracker table if it does not already exist.
 * Idempotent via CREATE TABLE IF NOT EXISTS. This table is owned by migrate.js
 * and must never be treated as a migration file.
 */
async function ensureTrackerTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id SERIAL PRIMARY KEY,
            filename TEXT UNIQUE NOT NULL,
            content_hash TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
}

/**
 * Compute a sha256 content hash of a migration file's raw bytes. Keying on
 * (filename, content_hash) means an unchanged file is skipped, while a file
 * whose CONTENT later changes (new hash) will be re-executed.
 */
function hashFileContent(filename) {
    const raw = fs.readFileSync(path.join(SQL_DIR, filename), 'utf8');
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Return true if this exact (filename, content_hash) pair has already been
 * applied and recorded in the _migrations tracker.
 */
async function isFileApplied(pool, filename, contentHash) {
    const res = await pool.query(
        'SELECT 1 FROM _migrations WHERE filename = $1 AND content_hash = $2 LIMIT 1',
        [filename, contentHash]
    );
    return res.rowCount > 0;
}

if (require.main === module) {
    run().catch((err) => {
        console.error('[migrate] Unexpected error:', err);
        process.exitCode = 1;
    });
}

/**
 * Return the sorted list of migration SQL file paths, relative to SQL_DIR
 * (e.g. '001_log_hypertable.sql', 'migrations/002_backfill_pid_columns.sql').
 * Walks SQL_DIR recursively so nested migration directories are discovered.
 *
 * Keys are RELATIVE paths on purpose: a top-level file's relative path equals
 * its bare basename, so existing `_migrations.filename` rows keep matching
 * exactly (no re-run, no renumber), while a nested file gets a distinct
 * 'migrations/...' key that can never collide with a top-level basename.
 * Used by tests and diagnostics.
 */
function listMigrationFiles() {
    return collectSqlFiles(SQL_DIR)
        .map((p) => path.relative(SQL_DIR, p))
        .sort();
}

/**
 * Recursively collect the absolute path of every *.sql file under `dir`.
 */
function collectSqlFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectSqlFiles(full));
        } else if (entry.name.endsWith('.sql')) {
            out.push(full);
        }
    }
    return out;
}

module.exports = { listMigrationFiles, isBenignError };
