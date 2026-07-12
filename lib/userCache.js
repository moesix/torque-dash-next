/**
 * Tiny in-memory TTL cache with a negative-cache path.
 *
 * Chosen over `node-cache` to avoid adding a new dependency (per Tier-2 build
 * constraints). Values are stored with a TTL; negative results are cached by
 * storing `null` so we can distinguish "not found" from "not cached":
 *   - get() returns the stored value (which may be `null` for a negative entry)
 *     when present and fresh.
 *   - get() returns `undefined` only when the key is absent or expired.
 */
class UserCache {
    constructor({ ttl = 300000, max = 5000 } = {}) {
        this.ttl = ttl;          // default 300s
        this.max = max;          // max entries before eviction
        this.store = new Map();  // insertion-ordered
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.exp) {
            this.store.delete(key);
            return undefined;
        }
        // Refresh recency for simple LRU-ish behavior.
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value; // may be null (negative cache hit)
    }

    set(key, value) {
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, { value, exp: Date.now() + this.ttl });
        if (this.store.size > this.max) {
            // Evict the oldest entry to stay within the cap.
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) this.store.delete(oldest);
        }
    }
}

module.exports = new UserCache();
module.exports.UserCache = UserCache;
