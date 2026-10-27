const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listMigrationFiles, isBenignError } = require('../scripts/migrate');

const SQL_DIR = path.join(__dirname, '..', 'infra', 'timescale');

describe('migration loader', () => {
    it('returns files in strict lexicographic path order 000–023 then migrations/', () => {
        const files = listMigrationFiles();
        const expected = [
            '000_baseline_tables.sql',
            '001_log_hypertable.sql',
            '002_settings.sql',
            '003_add_llm_settings.sql',
            '004_add_analyses_table.sql',
            '005_add_analysis_reasoning.sql',
            '006_add_deepseek_settings.sql',
            '007_add_timezone_offset.sql',
            '008_add_session_notes.sql',
            '009_add_vehicles.sql',
            '010_add_llm_max_tokens.sql',
            '011_add_retention_settings.sql',
            '012_upload_token.sql',
            '013_users_sessions_baseline.sql',
            '014_add_token_version.sql',
            '015_normalize_emails.sql',
            '016_denormalize_summaries.sql',
            '017_user_admin.sql',
            '018_drop_forward_urls.sql',
            '019_analysis_retention.sql',
            '020_analyses_created_id_unique.sql',
            '021_add_map_tile_settings.sql',
            '022_remove_share_surface.sql',
            '023_user_admin_guarded.sql',
            'migrations/001_add_upload_token.sql',
            'migrations/002_backfill_pid_columns.sql',
        ];
        assert.deepEqual(files, expected);
    });

    it('discovers the nested migrations/ directory (incl. the PID backfill)', () => {
        const files = listMigrationFiles();
        assert.ok(
            files.includes('migrations/002_backfill_pid_columns.sql'),
            'nested backfill must be in the discovered set so it actually executes'
        );
        assert.ok(files.includes('migrations/001_add_upload_token.sql'));
    });

    it('orders top-level files before nested migrations/ files', () => {
        const files = listMigrationFiles();
        const lastTopLevel = files.findIndex((f) => f.startsWith('migrations/'));
        assert.ok(lastTopLevel > 0, 'nested dir should sort after top-level files');
        assert.ok(
            files.slice(lastTopLevel).every((f) => f.startsWith('migrations/')),
            'all nested files must sort contiguously after top-level files'
        );
    });

    it('has no unnumbered SQL files', () => {
        const files = listMigrationFiles();
        const unnumbered = files.filter((f) => !/^\d{3}_/.test(path.basename(f)));
        assert.deepEqual(unnumbered, [], `unexpected unnumbered files: ${unnumbered.join(', ')}`);
    });
});

describe('baseline schema parity', () => {
    it('000_baseline_tables.sql creates only "Logs" with the toLogRow() columns', () => {
        const sql = fs.readFileSync(path.join(SQL_DIR, '000_baseline_tables.sql'), 'utf8');
        const created = [...sql.matchAll(/CREATE TABLE[^"]*"([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(created, ['Logs'], '000 must not create any other base table');
        const columns = [
            'id SERIAL PRIMARY KEY',
            '"sessionId" INTEGER NOT NULL',
            '"timestamp" TIMESTAMPTZ NOT NULL',
            'lon DOUBLE PRECISION',
            'lat DOUBLE PRECISION',
            'values JSONB',
            '"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()',
            '"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()',
        ];
        for (const column of columns) {
            assert.ok(sql.includes(column), `baseline Logs DDL must define ${column}`);
        }
        assert.ok(!/\$\$/.test(sql), 'no dollar-quoted blocks (the runner splits on ;)');
    });

    it('023_user_admin_guarded.sql promotes only when no admin exists', () => {
        const sql = fs.readFileSync(path.join(SQL_DIR, '023_user_admin_guarded.sql'), 'utf8');
        assert.ok(
            sql.includes('NOT EXISTS (SELECT 1 FROM "Users" WHERE "isAdmin")'),
            'guard must skip promotion when an admin already exists'
        );
        assert.ok(!/\$\$/.test(sql), 'no dollar-quoted blocks (the runner splits on ;)');
    });
});

describe('isBenignError', () => {
    it('accepts duplicate object (42P07)', () => {
        assert.equal(isBenignError({ code: '42P07', message: 'relation "foo" already exists' }), true);
    });

    it('accepts duplicate column (42701)', () => {
        assert.equal(isBenignError({ code: '42701', message: 'column "bar" of relation "baz" already exists' }), true);
    });

    it('accepts duplicate index (42710)', () => {
        assert.equal(isBenignError({ code: '42710', message: 'index "idx_foo" already exists' }), true);
    });

    it('accepts multiple primary keys (42P16)', () => {
        assert.equal(isBenignError({ code: '42P16', message: 'multiple primary keys for table "foo"' }), true);
    });

    it('accepts "already exists" message', () => {
        assert.equal(isBenignError({ message: 'relation "foo" already exists' }), true);
    });

    it('accepts "already a hypertable"', () => {
        assert.equal(isBenignError({ message: 'table "Logs" is already a hypertable' }), true);
    });

    it('rejects missing table (does not exist)', () => {
        assert.equal(isBenignError({ message: 'relation "Settings" does not exist' }), false);
    });

    it('rejects unknown error', () => {
        assert.equal(isBenignError({ message: 'permission denied for table "foo"' }), false);
    });

    it('rejects undefined input', () => {
        assert.equal(isBenignError(undefined), false);
    });
});
