// Authentication middleware

function authenticate(req, res, next) {
    if(req.isAuthenticated()) {
        // User is authenticated, proceed to the next middleware/controller
        return next();
    }
    // Every protected route is mounted under /api and consumed as JSON (SPA and
    // Torque uploads), so unauthenticated requests always get a 401 — there are
    // no server-rendered HTML routes to redirect.
    return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = authenticate;
