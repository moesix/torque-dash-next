const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const SessionController = require('../controllers/SessionController');
const UploadController = require('../controllers/UploadController');
const UserController = require('../controllers/UserController');
const TelemetryController = require('../controllers/TelemetryController');

// Torque sends data through GET request rather than post. Ingestion is
// unauthenticated (email-gated) so we throttle per client IP. The cap is env-
// tunable because a single Torque device can burst well above 60/min when it
// reconnects and flushes a backlog. The fixed window of UPLOAD_RATE_LIMIT_MAX
// (default 600) per UPLOAD_RATE_LIMIT_WINDOW_MS (default 60000) already
// absorbs those bursts.
// When UPLOAD_API_TOKEN is set, requests presenting a matching
// `Authorization: Bearer <token>` header (a Torque app feature) bypass the
// limiter. This lets the known uploader flush backlog freely without opening a
// spoofable hole: the token is a secret configured in the Torque app, not a
// guessable query param, and cloudflared forwards the header intact.
const uploadLimiter = rateLimit({
    windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS) || 60000,
    max: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 600,
});
const uploadApiToken = process.env.UPLOAD_API_TOKEN;
function gateUpload(req, res, next) {
    if (uploadApiToken) {
        const auth = req.headers.authorization || '';
        if (auth === `Bearer ${uploadApiToken}`) return next();
    }
    return uploadLimiter(req, res, next);
}
router.get('/upload', gateUpload, UploadController.processUpload );

// 20 requests/min/IP on auth endpoints to slow credential stuffing.
router.post('/users/register', rateLimit({ windowMs: 60000, max: 20 }), UserController.register);
router.post('/users/login', rateLimit({ windowMs: 60000, max: 20 }), UserController.login);
router.get('/users/logout', UserController.logout);
router.get('/users/shareid', authenticate, UserController.getShareId);
// Public read of site settings (register/login pages need this to decide whether
// to show the signup form). Toggling requires an authenticated session.
router.get('/settings', UserController.getSettings);
router.put('/settings', authenticate, UserController.updateSettings);
router.get('/users/forwardurls', authenticate, UserController.getForwardUrls);
router.put('/users/forwardurls', authenticate, UserController.updateForwardUrls);
router.patch('/users/shareid', authenticate, UserController.toggleShareId);

router.get('/sessions', authenticate, SessionController.getAll);
router.get('/sessions/shared/:shareId', SessionController.getAllShared);
router.get('/sessions/shared/:shareId/:sessionId', SessionController.getOneShared);
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
