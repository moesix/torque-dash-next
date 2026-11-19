'use strict';

// These tests deliberately load `config/config.js` with different SESSION_KEYS
// values, so nothing may require it at module scope. Each case sets the env,
// clears the require cache and re-requires the module. The caller's environment
// is restored in a `finally` block so the rest of the process is unaffected.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const CONFIG_PATH = require.resolve('../config/config');

const ORIGINAL_SESSION_KEYS = process.env.SESSION_KEYS;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function loadConfigWith(sessionKeys) {
    try {
        process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
        process.env.SESSION_KEYS = sessionKeys;
        delete require.cache[CONFIG_PATH];
        return require('../config/config');
    } finally {
        if (ORIGINAL_SESSION_KEYS === undefined) {
            delete process.env.SESSION_KEYS;
        } else {
            process.env.SESSION_KEYS = ORIGINAL_SESSION_KEYS;
        }
        if (ORIGINAL_DATABASE_URL === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
        }
        delete require.cache[CONFIG_PATH];
    }
}

describe('config placeholder guard', () => {
    it('rejects the SESSION_KEYS placeholder shipped in .env.example', () => {
        assert.throws(
            () => loadConfigWith('CHANGE_ME_TO_A_RANDOM_HEX_STRING'),
            /placeholder/i
        );
    });

    it('rejects "please-change-this-in-production"', () => {
        assert.throws(
            () => loadConfigWith('please-change-this-in-production'),
            /placeholder/i
        );
    });

    it('rejects "changeme"', () => {
        assert.throws(
            () => loadConfigWith('changeme'),
            /placeholder/i
        );
    });

    it('rejects a placeholder in any position of a key list', () => {
        assert.throws(
            () => loadConfigWith('0123456789abcdef0123456789abcdef,change-me'),
            /placeholder/i
        );
    });

    it('accepts the CI test key used to load config in tests', () => {
        const config = loadConfigWith('ci-test-key-for-config-loading');
        assert.strictEqual(config.session.keys.length, 1);
    });

    it('accepts a real 48-char hex key', () => {
        const key = 'abcdef0123456789abcdef0123456789abcdef0123456789';
        assert.strictEqual(key.length, 48);
        const config = loadConfigWith(key);
        assert.deepStrictEqual(config.session.keys, [key]);
    });

    it('accepts multiple real hex keys (rotation)', () => {
        const first = 'abcdef0123456789abcdef0123456789abcdef0123456789';
        const second = '9876543210fedcba9876543210fedcba9876543210fedcba';
        const config = loadConfigWith(`${first},${second}`);
        assert.deepStrictEqual(config.session.keys, [first, second]);
    });

    it('restores the caller environment', () => {
        assert.strictEqual(process.env.SESSION_KEYS, ORIGINAL_SESSION_KEYS);
        assert.strictEqual(process.env.DATABASE_URL, ORIGINAL_DATABASE_URL);
    });
});
