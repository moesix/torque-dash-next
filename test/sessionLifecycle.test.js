'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe, beforeEach } = require('node:test');
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

// deserializeUser now consults a module-level TTL cache (config/passport.js).
// These tests reuse user id 1 with DIFFERENT mocked findByPk results per test,
// so each case must start from an empty cache to observe its own mock data.
const { userByIdCache } = require('../config/passport');

// Required AFTER the ../models stub above so UserController binds to the
// mock models instead of the real database-backed module.
const UserController = require('../controllers/UserController');

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
    beforeEach(() => {
        userByIdCache.store.clear();
    });

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

    test('rejects a stale cookie (tv one behind) after changePassword bumps tokenVersion', (_, done) => {
        // Regression for plan 096: after changePassword bumps tokenVersion 0 -> 1,
        // cookies minted before the change carry tv 0 and must be rejected.
        mockUserFindByPkResult = {
            id: 1, email: 'test@example.com', tokenVersion: 1,
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; }
        };
        const session = { id: 1, tv: 0 }; // cookie minted before the password change
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user, false, 'stale cookie must be rejected once tokenVersion is bumped');
            done();
        });
    });

    test('accepts the current cookie (tv matching) after changePassword bumps tokenVersion', (_, done) => {
        // req.logIn re-serializes with the NEW tokenVersion, so the device that
        // changed the password keeps working with its refreshed cookie.
        mockUserFindByPkResult = {
            id: 1, email: 'test@example.com', tokenVersion: 1,
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; }
        };
        const session = { id: 1, tv: 1 }; // cookie re-minted by changePassword's req.logIn
        passport.deserializeUser(session, (err, user) => {
            assert.ifError(err);
            assert.strictEqual(user.tokenVersion, 1, 'current session accepted after the bump');
            done();
        });
    });
});

describe('logout', () => {
    // Behavioral harness for UserController.logout: stubs req.logout and
    // req.session.destroy so we can observe the destroy call + response.
    function makeLogoutHarness({ logoutErr = null, destroyErr = null } = {}) {
        let destroyCalled = false;
        const req = {
            logout: (cb) => cb(logoutErr),
            session: {
                destroy: (cb2) => { destroyCalled = true; cb2(destroyErr); },
            },
        };
        const calls = { body: null, statusCode: null };
        const res = {
            status(code) { calls.statusCode = code; return res; },
            json(obj) { calls.body = obj; return res; },
        };
        return { req, res, calls, wasDestroyCalled: () => destroyCalled };
    }

    test('destroys the session store record and responds {ok:true}', () => {
        const h = makeLogoutHarness();
        UserController.logout(h.req, h.res);
        assert.strictEqual(h.wasDestroyCalled(), true, 'req.session.destroy must be called');
        assert.deepStrictEqual(h.calls.body, { ok: true });
    });

    test('still responds {ok:true} when session.destroy errors (log-only)', () => {
        const h = makeLogoutHarness({ destroyErr: new Error('store unavailable') });
        UserController.logout(h.req, h.res);
        assert.strictEqual(h.wasDestroyCalled(), true, 'destroy must still be attempted');
        assert.deepStrictEqual(h.calls.body, { ok: true }, 'response contract must hold even on destroy error');
    });

    test('proceeds to session.destroy even when req.logout errors (log-only)', () => {
        const h = makeLogoutHarness({ logoutErr: new Error('passport logout failed') });
        UserController.logout(h.req, h.res);
        assert.strictEqual(h.wasDestroyCalled(), true, 'destroy must run despite logout error');
        assert.deepStrictEqual(h.calls.body, { ok: true }, 'response contract must hold even on logout error');
    });
});

describe('changePassword', () => {
    // Behavioral harness for UserController.changePassword: stubs the model
    // methods and session plumbing the controller touches, following the same
    // pattern as the logout harness above.
    beforeEach(() => {
        userByIdCache.store.clear();
    });

    function makeChangePasswordHarness({ currentPassword = 'old-secret', newPassword = 'brand-new-pass' } = {}) {
        const req = {
            body: { currentPassword, newPassword },
            user: { id: 1 },
            session: { regenerate: (cb) => cb(null) },
            logIn: (u, cb) => cb(null),
        };
        const calls = { statusCode: null, body: null };
        const res = {
            status(code) { calls.statusCode = code; return res; },
            json(obj) { calls.body = obj; return res; },
        };
        return { req, res, calls };
    }

    test('bumps tokenVersion by one, after the password update', async () => {
        const updateCalls = [];
        mockUserFindByPkResult = {
            id: 1,
            email: 'test@example.com',
            tokenVersion: 2,
            comparePassword: async () => true,
            update: async (patch) => { updateCalls.push(patch); },
            get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; },
        };
        const { req, res, calls } = makeChangePasswordHarness();
        await UserController.changePassword(req, res);
        assert.strictEqual(calls.body.ok, true, 'changePassword completed');
        assert.deepStrictEqual(updateCalls, [
            { password: 'brand-new-pass' },
            { tokenVersion: 3 }, // old tokenVersion (2) + 1
        ], 'password updated first, then tokenVersion bumped so deserializeUser rejects other sessions');
    });
});
