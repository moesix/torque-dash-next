const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { listMigrationFiles, isBenignError } = require('../scripts/migrate');

describe('migration loader', () => {
    it('returns files in strict lexicographic path order 001–019 then migrations/', () => {
        const files = listMigrationFiles();
        const expected = [
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
