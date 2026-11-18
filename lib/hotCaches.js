'use strict';

const userCache = require('./userCache');

// Hot-path identity caches for /api/upload: user is owned by lib/userCache;
// vehicle and session are per-controller concerns that live here so that
// SessionController can evict a session without importing a controller.
//
// Dedicated caches for the per-frame identity lookups. When the loaded
// userCache module doesn't expose the class (slim test doubles inject a plain
// get/set/del object), fall back to using that object as the backend.
const UserCacheClass = userCache.UserCache || null;
const vehicleCache = UserCacheClass ? new UserCacheClass({ ttl: 300_000, max: 1000 }) : userCache;
const sessionCache = UserCacheClass ? new UserCacheClass({ ttl: 60_000, max: 5000 }) : userCache;

// Drop the cached device-session → numeric FK mapping for one session. Called
// after a session row is deleted so the next upload re-resolves (and recreates)
// it instead of buffering frames against a nonexistent FK.
function evictSession(sessionKey, userId) {
    if (sessionKey == null || userId == null) return;
    sessionCache.del(`s:${userId}:${sessionKey}`);
}

module.exports = { userCache, vehicleCache, sessionCache, evictSession };
