/**
 * Runtime in-memory holder for the active upload API token.
 *
 * The rate limiter in routes/api.js reads this per-request so the DB is not
 * hit on every /upload invocation. The token is populated at boot via
 * initUploadApiToken() (called from app.js after DB sync) and kept in sync
 * whenever the Settings row is updated through the API.
 *
 * Environment variable UPLOAD_API_TOKEN always wins — it is the deploy-time
 * kill switch / override for the DB-stored token.
 */

let _uploadApiToken = null;
let _fromEnv = false;

/**
 * Load the active upload API token from env (priority) or DB, then store it
 * in the module-level variable. Called at server boot after models are loaded
 * and DB is synced.
 * @param {object} models — The sequelize models object (must have Settings)
 */
async function initUploadApiToken(models) {
    const envToken = process.env.UPLOAD_API_TOKEN;
    if (envToken) {
        _uploadApiToken = envToken;
        _fromEnv = true;
        return;
    }
    _fromEnv = false;
    try {
        const settings = await models.Settings.getSingleton();
        _uploadApiToken = settings.uploadApiToken || null;
    } catch {
        _uploadApiToken = null;
    }
}

/** @returns {string|null} The current upload API token, if any. */
function getUploadApiToken() {
    return _uploadApiToken;
}

/** @returns {boolean} True when the token was set from the env var (immutable via UI). */
function isFromEnv() {
    return _fromEnv;
}

/**
 * Update the runtime token (kept in sync when Settings are modified).
 * No-op when the active token was loaded from the env var (deploy-time override).
 * @param {string|null} token
 */
function setUploadApiToken(token) {
    if (_fromEnv) return;
    _uploadApiToken = token;
}

module.exports = { initUploadApiToken, getUploadApiToken, isFromEnv, setUploadApiToken };
