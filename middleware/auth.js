// Authentication middleware

function authenticate(req, res, next) {
    if(req.isAuthenticated()) {
        // User is authenticated, proceed to the next middleware/controller
        return next();
    }
    // User is not authenticated.
    // Routes are mounted under /api, so req.path is relative to the mount
    // (e.g. '/api/sessions' -> req.path === '/sessions'). Use originalUrl to
    // detect API requests and respond with 401 JSON instead of an HTML redirect.
    if (req.originalUrl.startsWith('/api')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // Legacy HTML routes keep the redirect behaviour.
    return res.redirect('/login');
}

module.exports = authenticate;