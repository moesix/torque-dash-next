const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authenticate = require('../middleware/auth');
const { rateLimits } = require('../config/config');
const SessionController = require('../controllers/SessionController');
const UploadController = require('../controllers/UploadController');
const UserController = require('../controllers/UserController');
const TelemetryController = require('../controllers/TelemetryController');
const runtime = require('../config/runtime');

// Shared limiter defaults: key on req.ip (real client IP via trust proxy),
// emit RFC-standard RateLimit-* headers, and return a JSON 429 so SPA and
// Torque clients get a consistent, parseable error.
function makeLimiter({ windowMs, max, skip }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skip,
        message: { error: 'Too many requests, please slow down.' },
    });
}

// Dedicated rate limiter for unauthenticated shared session endpoints.
// Stricter than global to prevent shareId enumeration.
const sharedLimiter = makeLimiter({
    windowMs: 60000,  // 1 minute
    max: 30,          // 30 requests per minute per IP
});

// Torque sends data through a GET request rather than POST. Ingestion is
// unauthenticated (email-gated) so we throttle per client IP. The cap is env-
// tunable because a single Torque device can burst well above 60/min when it
// reconnects and flushes a backlog; UPLOAD_RATE_LIMIT_MAX (default 600) per
// UPLOAD_RATE_LIMIT_WINDOW_MS (default 60000) absorbs those bursts.
// When UPLOAD_API_TOKEN is set, requests presenting a matching
// `Authorization: Bearer <token>` header (a Torque app feature) skip the
// limiter entirely. This lets the known uploader flush backlog freely without
// opening a spoofable hole: the token is a secret configured in the Torque app,
// not a guessable query param, and cloudflared forwards the header intact.
const uploadLimiter = makeLimiter(rateLimits.upload);
router.get('/upload', uploadLimiter, UploadController.processUpload);

// Stricter limiter for auth endpoints to slow brute-force / credential spray.
const authLimiter = makeLimiter(rateLimits.auth);
// Tighter limiter for authenticated mutations to bound write churn.
const writeLimiter = makeLimiter(rateLimits.write);
// Public read of site settings (register/login pages need this to decide whether
// to show the signup form). Toggling requires an authenticated session.
router.get('/settings', UserController.getSettings);
// Settings mutation and token generation use writeLimiter only (no global limiter
// redundancy). Must come before the global limiter below.
router.put('/settings', writeLimiter, authenticate, UserController.updateSettings);
router.post('/settings/upload-token', writeLimiter, authenticate, UserController.generateUploadToken);
// Catch-all limiter for every remaining /api route (reads, session queries).
// Registered here so it covers all routes declared below (but NOT /upload
// or /settings, which have their own limiters above).
router.use(makeLimiter(rateLimits.global));

router.post('/users/register', authLimiter, UserController.register);
router.post('/users/login', authLimiter, UserController.login);
router.get('/users/logout', UserController.logout);
router.get('/users/shareid', authenticate, UserController.getShareId);
router.get('/users/forwardurls', authenticate, UserController.getForwardUrls);
router.put('/users/forwardurls', writeLimiter, authenticate, UserController.updateForwardUrls);
router.post('/users/change-password', writeLimiter, authenticate, UserController.changePassword);
router.patch('/users/shareid', authenticate, UserController.toggleShareId);

router.get('/sessions', authenticate, SessionController.getAll);
router.get('/sessions/shared/:shareId', sharedLimiter, SessionController.getAllShared);
router.get('/sessions/shared/:shareId/:sessionId', sharedLimiter, SessionController.getOneShared);
router.get('/sessions/:sessionId', authenticate, SessionController.getOne);
router.delete('/sessions/:sessionId', authenticate, SessionController.delete);

// Paged telemetry frames (ownership enforced inside the controller)
router.get('/sessions/:id/telemetry', authenticate, TelemetryController.range);

router.patch('/sessions/rename/:sessionId', authenticate, SessionController.rename);
router.patch('/sessions/addlocation/:sessionId', authenticate, SessionController.addLocation);
router.patch('/sessions/filter/:sessionId', authenticate, SessionController.filter);
router.patch('/sessions/cut/:sessionId', authenticate, SessionController.cut);
router.post('/sessions/copy/:sessionId', authenticate, SessionController.copy);
router.post('/sessions/join/:sessionId', authenticate, SessionController.join);


module.exports = router;
