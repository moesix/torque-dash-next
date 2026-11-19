'use strict';

// Explicit HTTP errors thrown by handlers. Anything else is a 500 and is
// logged server-side with its stack; its message is never sent to the client.
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const badRequest = (m = 'Bad request') => new HttpError(400, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const forbidden = (m = 'Forbidden') => new HttpError(403, m);

// Terminal error middleware — registered after the 404 JSON handler.
function errorMiddleware(err, req, res, next) {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
    const body = { error: status >= 500 ? 'Internal server error' : (err.message || 'Request failed') };
    res.status(status).json(body);
}

module.exports = { HttpError, badRequest, notFound, forbidden, errorMiddleware };
