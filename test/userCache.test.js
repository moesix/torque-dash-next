'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the class directly (not the singleton) so we can create isolated
// instances with tiny TTLs for testing.
const { UserCache } = require('../lib/userCache');

describe('UserCache', () => {
  test('fresh get returns the stored value', () => {
    const cache = new UserCache({ ttl: 1000, max: 10 });
    cache.set('user:1', { name: 'Alice' });
    assert.deepStrictEqual(cache.get('user:1'), { name: 'Alice' });
  });

  test('get returns undefined for missing key', () => {
    const cache = new UserCache({ ttl: 1000, max: 10 });
    assert.strictEqual(cache.get('nonexistent'), undefined);
  });

  test('get returns undefined after TTL expires', async () => {
    const cache = new UserCache({ ttl: 20, max: 10 });
    cache.set('key', 'value');
    assert.strictEqual(cache.get('key'), 'value');
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(cache.get('key'), undefined);
  });

  test('negative cache stores null (distinct from undefined)', () => {
    const cache = new UserCache({ ttl: 1000, max: 10 });
    cache.set('user:999', null); // negative cache entry
    assert.strictEqual(cache.get('user:999'), null);
    // undefined means "not cached at all"
    assert.strictEqual(cache.get('user:888'), undefined);
  });

  test('eviction beyond max evicts the oldest entry', () => {
    const cache = new UserCache({ ttl: 10000, max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // All three should be present
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('c'), 3);
    // Adding a 4th evicts the oldest ('a')
    cache.set('d', 4);
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('c'), 3);
    assert.strictEqual(cache.get('d'), 4);
  });

  test('refresh-on-get recency keeps entry alive', async () => {
    const cache = new UserCache({ ttl: 30, max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    // Access 'a' to refresh its recency — it should now be the most recent
    cache.get('a');
    cache.set('c', 3);
    cache.set('d', 4); // Should evict 'b' (oldest unaccessed), not 'a'
    assert.strictEqual(cache.get('a'), 1);  // still alive
    assert.strictEqual(cache.get('b'), undefined); // evicted
    assert.strictEqual(cache.get('c'), 3);
    assert.strictEqual(cache.get('d'), 4);
  });

  test('set with same key updates the value', () => {
    const cache = new UserCache({ ttl: 1000, max: 10 });
    cache.set('k', 'old');
    assert.strictEqual(cache.get('k'), 'old');
    cache.set('k', 'new');
    assert.strictEqual(cache.get('k'), 'new');
  });
});
