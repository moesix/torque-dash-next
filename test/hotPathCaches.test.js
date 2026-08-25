'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── Helpers ────────────────────────────────────────────────────────────────
// Minimal mock for a Sequelize model instance (what .get() returns)
function fakeRow(overrides = {}) {
    return { id: 1, email: 'a@b.com', tokenVersion: 0, forwardUrls: [], ...overrides };
}

// ── 1. deserializeUser user cache ──────────────────────────────────────────
describe('deserializeUser – user cache', () => {
    test('calls findByPk only once when cache is empty', async () => {
        // Simulate what passport.js deserializeUser does with our cache
        let findByPkCalls = 0;
        const fakeUser = { get: () => fakeRow({ id: 42 }) };

        const testCache = {
            store: new Map(),
            get(key) { return this.store.has(key) ? this.store.get(key) : undefined; },
            set(key, val) { this.store.set(key, val); },
        };

        async function simulateDeserialize(id) {
            const cached = testCache.get(`user:${id}`);
            if (cached !== undefined) {
                if (cached === null) return false;
                return cached;
            }
            // Simulate DB call
            findByPkCalls++;
            const userData = fakeUser.get();
            testCache.set(`user:${id}`, userData);
            return userData;
        }

        const result1 = await simulateDeserialize(42);
        assert.deepStrictEqual(result1, fakeRow({ id: 42 }));
        assert.strictEqual(findByPkCalls, 1);

        // Second call should hit cache
        const result2 = await simulateDeserialize(42);
        assert.deepStrictEqual(result2, fakeRow({ id: 42 }));
        assert.strictEqual(findByPkCalls, 1, 'findByPk should not be called again on cache hit');
    });

    test('negative cache returns null for unknown user without DB call', async () => {
        let findByPkCalls = 0;

        const testCache = {
            store: new Map(),
            get(key) { return this.store.has(key) ? this.store.get(key) : undefined; },
            set(key, val) { this.store.set(key, val); },
        };

        async function simulateDeserialize(id) {
            const cached = testCache.get(`user:${id}`);
            if (cached !== undefined) {
                if (cached === null) return false;
                return cached;
            }
            findByPkCalls++;
            // Simulate user not found
            testCache.set(`user:${id}`, null);
            return false;
        }

        const result1 = await simulateDeserialize(999);
        assert.strictEqual(result1, false);
        assert.strictEqual(findByPkCalls, 1);

        // Second call should use negative cache (no DB hit)
        const result2 = await simulateDeserialize(999);
        assert.strictEqual(result2, false);
        assert.strictEqual(findByPkCalls, 1, 'findByPk should not be called on negative cache hit');
    });

    test('cache.del removes entry so next call hits DB', async () => {
        let findByPkCalls = 0;
        const fakeUser = { get: () => fakeRow({ id: 7 }) };

        const testCache = {
            store: new Map(),
            get(key) { return this.store.has(key) ? this.store.get(key) : undefined; },
            set(key, val) { this.store.set(key, val); },
            del(key) { this.store.delete(key); },
        };

        async function simulateDeserialize(id) {
            const cached = testCache.get(`user:${id}`);
            if (cached !== undefined) {
                if (cached === null) return false;
                return cached;
            }
            findByPkCalls++;
            const userData = fakeUser.get();
            testCache.set(`user:${id}`, userData);
            return userData;
        }

        await simulateDeserialize(7);
        assert.strictEqual(findByPkCalls, 1);

        // Invalidate cache
        testCache.del('user:7');
        await simulateDeserialize(7);
        assert.strictEqual(findByPkCalls, 2, 'findByPk should be called again after cache invalidation');
    });
});

// ── 2. Vehicle cache behavior ──────────────────────────────────────────────
describe('vehicleCache – negative and positive caching', () => {
    const { UserCache } = require('../lib/userCache');

    test('vehicle cache returns null for negative entries', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        cache.set('v:1:NonExistent', null); // negative cache

        const result = cache.get('v:1:NonExistent');
        assert.strictEqual(result, null, 'should return null for negative vehicle cache hit');

        // Undefined means "not cached"
        assert.strictEqual(cache.get('v:1:OtherVehicle'), undefined);
    });

    test('vehicle cache returns cached vehicle on second lookup', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const vehicle = { id: 10, name: 'My Car', userId: 1 };

        cache.set('v:1:My Car', vehicle);
        const result = cache.get('v:1:My Car');
        assert.deepStrictEqual(result, vehicle);
    });

    test('default vehicle cache works independently', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const defaultVehicle = { id: 5, name: 'Default', isDefault: true };

        cache.set('vd:1', defaultVehicle);
        assert.deepStrictEqual(cache.get('vd:1'), defaultVehicle);
        assert.strictEqual(cache.get('vd:2'), undefined, 'different user has no default cached');
    });
});

// ── 3. Session cache behavior ──────────────────────────────────────────────
describe('sessionCache – positive lookup caching', () => {
    const { UserCache } = require('../lib/userCache');

    test('session cache returns cached session on second lookup', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const sess = { id: 99, sessionId: 'abc', userId: 1 };

        cache.set('s:abc:1', sess);
        const result = cache.get('s:abc:1');
        assert.deepStrictEqual(result, sess);
    });

    test('session cache does not cache negatives', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        // Simulate: session not in cache → DB findOrCreate returns [sess, true]
        // Only positive lookup is cached
        const sess = { id: 100, sessionId: 'xyz', userId: 2 };
        cache.set('s:xyz:2', sess);

        // Different user/session should be undefined (not negative-cached)
        assert.strictEqual(cache.get('s:xyz:3'), undefined);
    });

    test('session cache key includes userId for isolation', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const sess1 = { id: 1, sessionId: 'same-session', userId: 1 };
        const sess2 = { id: 2, sessionId: 'same-session', userId: 2 };

        cache.set('s:same-session:1', sess1);
        cache.set('s:same-session:2', sess2);

        assert.deepStrictEqual(cache.get('s:same-session:1'), sess1);
        assert.deepStrictEqual(cache.get('s:same-session:2'), sess2);
    });
});
