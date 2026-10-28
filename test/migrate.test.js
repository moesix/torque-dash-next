const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listMigrationFiles, isBenignError } = require('../scripts/migrate');

const SQL_DIR = path.join(__dirname, '..', 'infra', 'timescale');

describe('migration loader', () => {
    it('returns files in strict lexicographic path order 000–024 then migrations/', () => {
        const files = listMigrationFiles();
        const expected = [
            '000_baseline_tables.sql',
            '000_users_sessions_baseline.sql',
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
            '024_session_max_types.sql',
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

describe('baseline schema', () => {
    it('000 defines exactly the base Logs columns', () => {
        // This checks the DDL text only — it cannot detect drift between the
        // file and the Sequelize Log model.
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

    it('022 drops the shareId constraint before its index and column', () => {
        const sql = fs.readFileSync(path.join(SQL_DIR, '022_remove_share_surface.sql'), 'utf8');
        const constraintAt = sql.indexOf('DROP CONSTRAINT IF EXISTS "Users_shareId_key"');
        const indexAt = sql.indexOf('DROP INDEX IF EXISTS "Users_shareId_key"');
        const columnAt = sql.indexOf('DROP COLUMN IF EXISTS "shareId"');
        assert.ok(constraintAt !== -1, '022 must drop the sync-created UNIQUE constraint');
        assert.ok(indexAt === -1 || constraintAt < indexAt, 'constraint drop must precede index drop');
        assert.ok(columnAt > constraintAt, 'column drop must follow the constraint drop');
    });

    it('002 creates Settings with both timestamp columns', () => {
        const sql = fs.readFileSync(path.join(SQL_DIR, '002_settings.sql'), 'utf8');
        for (const column of [
            '"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()',
            '"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()',
        ]) {
            assert.ok(sql.includes(column), `002 must define ${column}`);
        }
    });

    it('023_user_admin_guarded.sql promotes only when no admin exists', () => {
        const sql = fs.readFileSync(path.join(SQL_DIR, '023_user_admin_guarded.sql'), 'utf8');
        assert.ok(
            sql.includes('NOT EXISTS (SELECT 1 FROM "Users" WHERE "isAdmin")'),
            'guard must skip promotion when an admin already exists'
        );
        assert.ok(!/\$\$/.test(sql), 'no dollar-quoted blocks (the runner splits on ;)');
    });

    it('024_session_max_types.sql retypes both summary columns to DOUBLE PRECISION', () => {
        const sql = fs.readFileSync(path.join(SQL_DIR, '024_session_max_types.sql'), 'utf8');
        for (const column of ['"maxRpm"', '"maxSpeed"']) {
            assert.ok(
                sql.includes(`ALTER TABLE "Sessions" ALTER COLUMN ${column} TYPE DOUBLE PRECISION;`),
                `024 must retype Sessions.${column}`
            );
        }
        assert.ok(!/\$\$/.test(sql), 'no dollar-quoted blocks (the runner splits on ;)');
    });
});

describe('fresh-install ordering baseline (000_users_sessions_baseline.sql)', () => {
    const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

    // Column lines of a CREATE TABLE block, whitespace-normalized so the
    // comparison is about DDL meaning, not indentation.
    function createTableColumns(sql, table) {
        const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\);`));
        assert.ok(match, `CREATE TABLE IF NOT EXISTS "${table}" block must exist`);
        return match[1]
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('--'));
    }

    it('sorts after the Logs baseline and before 001 (and 004)', () => {
        const files = listMigrationFiles();
        const baseline = files.indexOf('000_users_sessions_baseline.sql');
        assert.ok(baseline > files.indexOf('000_baseline_tables.sql'));
        assert.ok(baseline < files.indexOf('001_log_hypertable.sql'));
        assert.ok(baseline < files.indexOf('004_add_analyses_table.sql'));
    });

    it('Users DDL matches 013 column for column', () => {
        assert.deepEqual(
            createTableColumns(readSql('000_users_sessions_baseline.sql'), 'Users'),
            createTableColumns(readSql('013_users_sessions_baseline.sql'), 'Users')
        );
    });

    it('Sessions DDL matches 013 column for column', () => {
        assert.deepEqual(
            createTableColumns(readSql('000_users_sessions_baseline.sql'), 'Sessions'),
            createTableColumns(readSql('013_users_sessions_baseline.sql'), 'Sessions')
        );
    });

    it('carries the same unique indexes as 013', () => {
        const sql = readSql('000_users_sessions_baseline.sql');
        for (const index of [
            'CREATE UNIQUE INDEX IF NOT EXISTS "Users_email_key" ON "Users" (email);',
            'CREATE UNIQUE INDEX IF NOT EXISTS "Sessions_sessionId_key" ON "Sessions" ("sessionId");',
        ]) {
            assert.ok(sql.includes(index), `000_users_sessions_baseline must define ${index}`);
        }
    });

    it('adds the Logs -> Sessions foreign key with ON DELETE CASCADE', () => {
        const sql = readSql('000_users_sessions_baseline.sql').replace(/\s+/g, ' ');
        assert.ok(
            sql.includes(
                'ALTER TABLE "Logs" ADD CONSTRAINT "Logs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Sessions"(id) ON DELETE CASCADE;'
            ),
            'fresh Logs must cascade-delete telemetry with its session'
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

    it('accepts table options on a not-yet-hypertable (001 compression pre-conversion)', () => {
        assert.equal(
            isBenignError({ message: 'timescaledb table options can only be specified for hypertables' }),
            true
        );
    });

    it('still rejects arbitrary errors with a similar shape', () => {
        assert.equal(isBenignError({ message: 'table options are not supported here' }), false);
        assert.equal(isBenignError({ message: 'compression is not enabled for this hypertable' }), false);
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
