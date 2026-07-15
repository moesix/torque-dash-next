# HIGH Security Fixes — Execution Plan

**Date:** 2026-07-15
**Status:** Ready for implementation
**Scope:** 6 HIGH findings from security audit

---

## Overview

| # | Finding | Risk | Files | Decision |
|---|---------|------|-------|----------|
| H1 | `express.urlencoded({ extended: true })` prototype pollution | HIGH | `app.js` | Change to `false` |
| H2 | Shared session endpoints weak rate limiting | HIGH | `routes/api.js` | Add dedicated limiter |
| H3 | Upload bearer token only skips rate limit | HIGH | `routes/api.js`, `controllers/UploadController.js` | **Bearer token REQUIRED** |
| H4 | `console.log` leaks user data | HIGH | `controllers/UserController.js` | Remove all PII logs |
| H5 | Session not invalidated on password change | HIGH | `controllers/UserController.js`, `models/User.js` | **Regenerate session ID** |
| H6 | Docker containers run as root | HIGH | `Dockerfile`, `apps/frontend/Dockerfile` | **nginx-unprivileged** |

---

## H1: Fix `express.urlencoded({ extended: true })`

### Problem
The `extended: true` option uses the `qs` library which allows prototype pollution via crafted payloads.

### File: `app.js`

### Change
```javascript
// Line 40: Change from
app.use(express.urlencoded({ extended: true }));

// To
app.use(express.urlencoded({ extended: false }));
```

### Testing
- Verify Torque native app (sends form-encoded data) still works
- Test with prototype pollution payload: `__proto__[test]=polluted`

---

## H2: Rate Limit Shared Session Endpoints

### Problem
`/api/sessions/shared/:shareId` is unauthenticated and only protected by global rate limiter (600/min). Attacker can enumerate shareIds.

### File: `routes/api.js`

### Changes

**1. Add shared limiter after line 24 (after `makeLimiter` function):**
```javascript
// Dedicated rate limiter for unauthenticated shared session endpoints.
// Stricter than global to prevent shareId enumeration.
const sharedLimiter = makeLimiter({
    windowMs: 60000,  // 1 minute
    max: 30,          // 30 requests per minute per IP
});
```

**2. Apply to shared endpoints (lines 71-72):**
```javascript
// Before
router.get('/sessions/shared/:shareId', SessionController.getAllShared);
router.get('/sessions/shared/:shareId/:sessionId', SessionController.getOneShared);

// After
router.get('/sessions/shared/:shareId', sharedLimiter, SessionController.getAllShared);
router.get('/sessions/shared/:shareId/:sessionId', sharedLimiter, SessionController.getOneShared);
```

### Testing
- Send 31 requests to `/api/sessions/shared/test` in 1 minute → should get 429
- Verify legitimate shared session access still works

---

## H3: Make Bearer Token Required for Uploads

### Problem
Bearer token only skips rate limit — doesn't gate access. Attacker with valid email can inject data.

### Decision
**Bearer token is REQUIRED when `UPLOAD_API_TOKEN` is configured.** This is a breaking change for users without the token set — they must configure it.

### File 1: `controllers/UploadController.js`

### Changes

**Add authentication check at the start of `processUpload` method (after line 21):**
```javascript
static async processUpload(req, res) {
    try {
        // ── AUTHENTICATION ──────────────────────────────────────────────
        // When UPLOAD_API_TOKEN is configured, bearer token is REQUIRED.
        // This is a security gate — email alone is not sufficient auth.
        const configuredToken = runtime.getUploadApiToken();
        if (configuredToken) {
            const authHeader = req.headers.authorization || '';
            if (!authHeader.startsWith('Bearer ')) {
                return res.status(401).json({
                    error: 'Authorization header required',
                    hint: 'Set Authorization: Bearer <your-token> in Torque Pro'
                });
            }
            const token = authHeader.slice(7);
            if (token !== configuredToken) {
                return res.status(401).json({ error: 'Invalid upload token' });
            }
        }
        // ── END AUTHENTICATION ─────────────────────────────────────────

        let { eml, session, time } = req.query;
        // ... rest of existing code
```

### File 2: `routes/api.js`

### Changes

**Simplify upload route (lines 36-44):**
```javascript
// Before
const uploadLimiter = makeLimiter({
    ...rateLimits.upload,
    skip: (req) => {
        const token = runtime.getUploadApiToken();
        return Boolean(token) &&
            (req.headers.authorization || '') === `Bearer ${token}`;
    },
});
router.get('/upload', uploadLimiter, UploadController.processUpload);

// After — auth is now in the controller, rate limiter always applies
const uploadLimiter = makeLimiter(rateLimits.upload);
router.get('/upload', uploadLimiter, UploadController.processUpload);
```

### Migration Guide (add to README)
```markdown
## Breaking Change: Upload Authentication

As of this version, when `UPLOAD_API_TOKEN` is configured, all uploads MUST
include the bearer token in the Authorization header.

**Torque Pro Configuration:**
1. Set `UPLOAD_API_TOKEN` in your `.env` file
2. In Torque Pro, go to Settings → Advanced → HTTP Auth Token
3. Enter your token
4. Torque Pro will automatically add `Authorization: Bearer <token>` to uploads

Without the token, uploads will return 401 Unauthorized.
```

### Testing
- Upload without `UPLOAD_API_TOKEN` set → should work (backward compatible)
- Upload with `UPLOAD_API_TOKEN` set, no auth header → should get 401
- Upload with `UPLOAD_API_TOKEN` set, wrong token → should get 401
- Upload with `UPLOAD_API_TOKEN` set, correct token → should work

---

## H4: Remove `console.log` Data Leaks

### Problem
User data (forwardUrls, shareId) logged to stdout, may be captured by log aggregation.

### File: `controllers/UserController.js`

### Changes

**1. Line 71 — Remove forwardUrls log:**
```javascript
// Before
let forwardUrls = user.forwardUrls;
console.log(forwardUrls);

// After
let forwardUrls = user.forwardUrls;
// Removed: console.log leaked user forward URLs
```

**2. Line 108 — Remove shareId log:**
```javascript
// Before
let shareId = user.shareId;
console.log(shareId);

// After
let shareId = user.shareId;
// Removed: console.log leaked user share ID
```

**3. Line 89 — Remove error log with user data:**
```javascript
// Before (in catch blocks)
console.log(err);

// After
console.error(err.message || err);
```

**4. Lines 76, 98, 113, 132, 149, 211, 233 — Standardize error logging:**
```javascript
// Before
console.log(err);

// After
console.error('[UserController]', err.message || err);
```

### Testing
- Perform user operations (get forward URLs, get share ID)
- Check server logs — should not contain PII

---

## H5: Regenerate Session on Password Change

### Problem
When password changes, existing sessions remain valid. Attacker with stolen session cookie can continue using it.

### Decision
**Regenerate session ID on password change** — simplest approach, invalidates all other sessions.

### File 1: `controllers/UserController.js`

### Changes

**Add password change endpoint (after `generateUploadToken` method, before closing brace):**
```javascript
// Change password endpoint. Regenerates session to invalidate all other sessions.
static async changePassword(req, res) {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required.' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }

        const user = await User.findByPk(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Verify current password
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        // Update password (beforeUpdate hook will hash it)
        await user.update({ password: newPassword });

        // Regenerate session to invalidate all other sessions for this user
        req.session.regenerate((err) => {
            if (err) {
                console.error('[UserController] Session regeneration failed:', err.message);
                return res.status(500).json({ error: 'Password changed but session refresh failed.' });
            }
            // Re-login the user with the new session
            req.logIn(user, (loginErr) => {
                if (loginErr) {
                    return res.status(500).json({ error: 'Password changed but re-login failed.' });
                }
                return res.json({ ok: true, message: 'Password changed. Other sessions have been invalidated.' });
            });
        });
    } catch (err) {
        console.error('[UserController]', err.message || err);
        res.sendStatus(500);
    }
}
```

### File 2: `models/User.js`

### Changes

**1. Add `beforeUpdate` hook (line 25):**
```javascript
// Before
hooks: {
    beforeCreate: hashPassword,
}

// After
hooks: {
    beforeCreate: hashPassword,
    beforeUpdate: hashPassword,
}
```

**2. Update `hashPassword` function to check if password changed (line 56):**
```javascript
// Before
async function hashPassword (user) {
     const SALT_FACTOR = 8;
     const salt = await bcrypt.genSalt(SALT_FACTOR);
     let hash = await bcrypt.hash(user.password, salt);
     await user.setDataValue('password', hash);
}

// After
async function hashPassword (user) {
    // Only hash if password was actually changed (avoids re-hashing on other updates)
    if (!user.changed('password')) return;
    
    const SALT_FACTOR = 10;  // OWASP recommends minimum 10
    const salt = await bcrypt.genSalt(SALT_FACTOR);
    let hash = await bcrypt.hash(user.password, salt);
    await user.setDataValue('password', hash);
}
```

### File 3: `routes/api.js`

### Changes

**Add route (after line 67, with other user routes):**
```javascript
router.post('/users/change-password', writeLimiter, authenticate, UserController.changePassword);
```

### Testing
- Login → change password → old session cookie should be invalid
- Login with new password → should work
- Try to use old session → should get 401

---

## H6: Docker Containers Run as Root

### Problem
Neither Dockerfile specifies a non-root user. Container escape gives root access.

### Decision
**Use `nginxinc/nginx-unprivileged`** for frontend (runs as non-root by default). Backend gets explicit non-root user.

### File 1: `Dockerfile` (backend)

### Changes
```dockerfile
# torque-dash-next backend image
FROM node:20-bookworm-slim

# bcrypt@3 is a native addon compiled at install time, so we need build tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

# Set ownership
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

EXPOSE 3000

# Boot sequence:
#   1) sync() creates the base tables on first boot (idempotent).
#   2) migrate.js turns "Logs" into a TimescaleDB hypertable + seeds Settings.
#   3) start the API server.
CMD ["sh", "-c", "node -e \"require('./models').sequelize.sync().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);})\" && node scripts/migrate.js && node app.js"]
```

### File 2: `apps/frontend/Dockerfile`

### Changes
```dockerfile
# Multi-stage build: compile the Vite SPA, then serve it with nginx.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Use nginx-unprivileged image (runs as non-root by default)
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
```

### File 3: `apps/frontend/nginx.conf`

### Changes
```nginx
# Before (if it listens on port 80)
server {
    listen 80;
    # ...
}

# After (listen on unprivileged port)
server {
    listen 8080;
    # ...
}
```

### File 4: `docker-compose.yml` and `docker-compose.prod.yml`

### Changes
```yaml
# Frontend service - change port mapping
frontend:
    # Before
    ports:
      - "8080:80"
    
    # After
    ports:
      - "8080:8080"
```

### Testing
- Build and run containers
- `docker exec <backend-container> whoami` → should show `appuser`
- `docker exec <frontend-container> whoami` → should show `nginx` (unprivileged)
- Verify frontend serves on port 8080

---

## Implementation Order

| Step | Finding | Risk | Dependencies |
|------|---------|------|--------------|
| 1 | H1 | Low | None |
| 2 | H4 | Low | None |
| 3 | H2 | Low | None |
| 4 | H3 | Medium | None |
| 5 | H5 | High | H4 (error logging style) |
| 6 | H6 | Medium | None |

**Parallel execution possible:** Steps 1, 2, 3 can run in parallel.
**Sequential required:** Step 5 after Step 4.

---

## Testing Checklist

- [ ] H1: Form-encoded data still works
- [ ] H1: Prototype pollution payload rejected
- [ ] H2: 31 requests to shared endpoint → 429
- [ ] H2: Legitimate shared access works
- [ ] H3: Upload without token configured → works
- [ ] H3: Upload with token configured, no header → 401
- [ ] H3: Upload with token configured, wrong token → 401
- [ ] H3: Upload with token configured, correct token → works
- [ ] H4: No PII in server logs
- [ ] H5: Password change invalidates other sessions
- [ ] H5: New password works after change
- [ ] H6: Backend runs as `appuser` not `root`
- [ ] H6: Frontend runs as `nginx` (unprivileged)
- [ ] H6: Frontend accessible on port 8080

---

## Rollback Plan

| Finding | Rollback |
|---------|----------|
| H1 | Change `extended: false` back to `true` |
| H2 | Remove `sharedLimiter` from routes |
| H3 | Remove auth check from UploadController, restore rate limiter skip |
| H4 | Add back `console.log` calls |
| H5 | Remove `changePassword` endpoint, remove `beforeUpdate` hook |
| H6 | Remove `USER appuser` directive, revert nginx image |

---

## Notes for Execution Model

1. **Read files first** — Verify current content before making changes
2. **Test after each change** — Don't batch all changes together
3. **Check for syntax errors** — Run `node -c <file>` after editing JS files
4. **Docker build test** — Run `docker compose build` after Dockerfile changes
5. **Update this document** — Mark items as complete as you finish them
