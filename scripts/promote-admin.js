#!/usr/bin/env node
'use strict';

// Promote or demote a user's admin flag after an upgrade.
//
// Migration 017's admin backfill promotes the LOWEST-id user (the
// deployment's original account) because existing users predate the
// first-registered-user bootstrap rule in UserController.register. On a
// multi-user deployment the operator may not be that account — this script
// is the recovery path: point it at the operator's email and the admin-only
// controls (token rotation, LLM config, registration toggle, retention) are
// reachable again.
//
// Usage:
//   node scripts/promote-admin.js <email>          # set isAdmin = true
//   node scripts/promote-admin.js --demote <email> # set isAdmin = false
//
// Reads DATABASE_URL from the environment (falling back to config/config.js,
// like scripts/migrate.js). Idempotent: re-running is a no-op UPDATE that
// still prints the user's id + email.

const { Pool } = require('pg');

/**
 * Core, testable logic: flip the isAdmin flag for the user with `email`.
 * Returns { id, email } of the updated user, or null when no user matches.
 */
async function promoteAdmin(pool, email, promote) {
    const normalized = String(email || '').trim().toLowerCase();
    const res = await pool.query(
        `UPDATE "Users" SET "isAdmin" = $1
         WHERE "email" = $2
         RETURNING "id", "email"`,
        [Boolean(promote), normalized]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return { id: row.id, email: row.email };
}

async function main() {
    const args = process.argv.slice(2);
    let promote = true;
    let emailArg;
    if (args[0] === '--demote') {
        promote = false;
        emailArg = args[1];
    } else {
        emailArg = args[0];
    }

    if (!emailArg) {
        console.error('Usage: node scripts/promote-admin.js [--demote] <email>');
        process.exitCode = 1;
        return;
    }

    const config = require('../config/config');
    const connectionString = process.env.DATABASE_URL || config.db.uri;
    const pool = new Pool({ connectionString });
    try {
        const result = await promoteAdmin(pool, emailArg, promote);
        if (!result) {
            console.error(`[promote-admin] No user found with email: ${emailArg}`);
            process.exitCode = 1;
            return;
        }
        const verb = promote ? 'promoted to admin' : 'demoted (admin flag removed)';
        console.log(`[promote-admin] User ${verb}: id=${result.id} email=${result.email}`);
    } catch (err) {
        console.error('[promote-admin] Error:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

module.exports = { promoteAdmin };

if (require.main === module) {
    main().catch((err) => {
        console.error('[promote-admin] Unexpected error:', err);
        process.exitCode = 1;
    });
}
