/**
 * Run the TimescaleDB hypertable migration against the configured database.
 *
 * Reads infra/timescale/log_hypertable.sql and executes each statement via the
 * `pg` client. This is idempotent in practice: the SQL guards with IF NOT EXISTS
 * where possible, and statements are executed individually so that benign
 * "already exists" / "does not exist" errors on re-run are tolerated and skipped.
 *
 * IMPORTANT: This script is run MANUALLY (e.g. `node scripts/migrate.js`).
 * It is NOT auto-run on server boot (see app.js bootstrap guard).
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config/config');

const SQL_DIR = path.join(__dirname, '..', 'infra', 'timescale');

// Errors that are safe to ignore when re-running a migration (idempotency).
function isBenignError(err) {
    const msg = (err && err.message) ? err.message : '';
    return (
        /already exists/i.test(msg) ||
        /does not exist/i.test(msg) ||
        /duplicate.*constraint/i.test(msg) ||
        /multiple primary keys/i.test(msg) ||
        /relation "log_1min" already exists/i.test(msg) ||
        /already a hypertable/i.test(msg) ||
        /operation not supported on hypertables that have compression enabled/i.test(msg)
    );
}

/**
 * Strip SQL comments so that semicolons inside /* ... *​/ or -- comments
 * don't fragment the naive ;-split below.  Block comments are stripped
 * first to avoid stripping line-comment syntax that appears inside them.
 */
function stripComments(sql) {
    // Strip /* ... */ block comments (non-greedy, handles multi-line)
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip -- line comments to end of line
    sql = sql.replace(/--[^\n]*/g, '');
    return sql;
}

// Load every *.sql file in the migration directory, in lexicographic order so
// e.g. `log_hypertable.sql` (TimescaleDB setup) runs before `settings.sql`.
function loadStatements() {
    const files = fs
        .readdirSync(SQL_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
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
    const connectionString = process.env.DATABASE_URL || config.db.uri;
    const pool = new Pool({ connectionString });

    const statements = loadStatements();
    console.log(`[migrate] Executing ${statements.length} statements across migration files...`);
    for (let i = 0; i < statements.length; i++) {
        const { sql: stmt, file } = statements[i];
        try {
            await pool.query(stmt);
            console.log(`[migrate] (${i + 1}/${statements.length}) [${file}] OK: ${stmt.slice(0, 60).replace(/\s+/g, ' ')}`);
        } catch (err) {
            if (isBenignError(err)) {
                console.warn(`[migrate] (${i + 1}/${statements.length}) [${file}] SKIP (benign): ${err.message}`);
            } else {
                console.error(`[migrate] (${i + 1}/${statements.length}) [${file}] FAILED: ${err.message}`);
                await pool.end();
                process.exitCode = 1;
                return;
            }
        }
    }

    console.log('[migrate] Done.');
    await pool.end();
}

run().catch((err) => {
    console.error('[migrate] Unexpected error:', err);
    process.exitCode = 1;
});
