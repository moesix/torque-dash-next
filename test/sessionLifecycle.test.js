'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const passport = require('passport');

// ── Pre-populate require.cache for ../models ────────────────────────
// passport.js requires ../models at the top level. We pre-populate the
// require cache so the config gets our stubs instead of loading the real
// module.
let mockUserFindByPkResult = { id: 1, email: 'test@example.com', tokenVersion: 0, get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; } };

const mockModels = {
    User: {
        findByPk: async () => mockUserFindByPkResult,
        findOne: async () => null,
    },
    Session: { findOne: async () => null, findAll: async () => [] },
    Vehicle: { findOne: async () => null, findAll: async () => [] },
    Log: { count: async () => 0 },
    Settings: { getSingleton: async () => ({}) },
};

// Force models/index.js out of require cache so our mock wins
Object.keys(require.cache).forEach((key) => {
    if (key.includes('models/index.js') || key.includes('models\\index.js')) {
        delete require.cache[key];
    }
});

// Stub models/index.js to return our mocks
require.cache[require.resolve('../models')] = {
    id: require.resolve('../models'),
    filename: require.resolve('../models'),
    loaded: true,
    exports: { ...mockModels, sequelize: { query: async () => [] } },
};

// Load passport config (registers serializeUser + deserializeUser)
require('../config/passport')(passport);

// ── Tests ───────────────────────────────────────────────────────────

describe('serializeUser', () => {
    test('stores {id, tv} with tokenVersion from user', (_, done) => {
        const user = { id: 42, tokenVersion: 5 };
        passport.serializeUser(user, (err, obj) => {
            assert.ifError(err);
            assert.deepStrictEqual(obj, { id: 42, tv: 5 });
            done();
        });
    });

    test('stores tv as 0 when user has no tokenVersion', (_, done) => {
        const user = { id: 7 };
        passport.serializeUser(user, (err, obj) => {
            assert.ifError(err);
            assert.deepStrictEqual(obj, { id: 7, tv: 0 });
            done();
        });
    });
});

describe('deserializeUser', () => {
    test('returns user when versions match', (_, done) => {
        mockUserFindByPkResult = {
            id: 1, email: 'test@example.com', tokenVersion: 3,
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; }
        };
        const session = { id: 1, tv: 3 };
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user.id, 1);
            assert.strictEqual(user.email, 'test@example.com');
            assert.strictEqual(user.tokenVersion, 3);
            done();
        });
    });

    test('rejects session when tokenVersion mismatches', (_, done) => {
        mockUserFindByPkResult = {
            id: 1, email: 'test@example.com', tokenVersion: 5,
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; }
        };
        const session = { id: 1, tv: 2 }; // stale session
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user, false, 'should return false on epoch mismatch');
            done();
        });
    });

    test('returns false when user not found', (_, done) => {
        mockUserFindByPkResult = null;
        const session = { id: 999, tv: 0 };
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user, false, 'should return false when user not found');
            done();
        });
    });

    test('treats missing tv in session as 0 (pre-migration compatibility)', (_, done) => {
        mockUserFindByPkResult = {
            id: 1, email: 'test@example.com', tokenVersion: 0,
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; }
        };
        const session = { id: 1 }; // no tv field — pre-migration session
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user.id, 1, 'should deserialize pre-migration session with tokenVersion 0');
            done();
        });
    });

    test('rejects pre-migration session when user has bumped tokenVersion', (_, done) => {
        mockUserFindByPkResult = {
            id: 1, email: 'test@example.com', tokenVersion: 1,
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; }
        };
        const session = { id: 1 }; // no tv field — treated as 0
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user, false, 'should reject pre-migration session after password change');
            done();
        });
    });
});
