const User = require('../models').User;
const Settings = require('../models').Settings;
const sequelize = require('../models').sequelize;
const passport = require('passport');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const runtime = require('../config/runtime');
const { userByIdCache } = require('../config/passport');
const { validateLlmThinkingMode, validateLlmMaxTokens, validateRetentionEnabled, validateRetentionDays, validateAnalysisRetentionDays, validateProvider } = require('../lib/validators');

// Admin = first registered user (bootstrap at register time, plan 099). Any
// admin-only mutation must call this first and return 403 when it fails.
function requireAdmin(req, res) {
    if (!req.user || !req.user.isAdmin) {
        res.status(403).json({ error: 'Admin access required.' });
        return false;
    }
    return true;
}

class UserController {
    static async login(req, res, next) {
        passport.authenticate('local', (err, user, info) => {
            if (err) return next(err);
            if (!user) {
                return res.status(401).json({ error: (info && info.message) || 'Invalid credentials' });
            }
            req.logIn(user, (loginErr) => {
                if (loginErr) return next(loginErr);
                return res.json({ ok: true });
            });
        })(req, res, next);
    }
    // Logout must ALSO destroy the express-session record so the
    // connect-pg-simple store row dies NOW, not at TTL (plan 054 intent).
    // Response contract stays { ok: true } — the SPA logout flow depends on
    // it; both failure modes (passport logout error, store destroy error)
    // are log-only.
    static async logout(req, res) {
        req.logout((err) => {
            if (err) console.error('[UserController] logout:', err.message);
            req.session.destroy((destroyErr) => {
                if (destroyErr) {
                    console.error('[UserController] session.destroy failed:', destroyErr.message);
                }
                return res.json({ ok: true });
            });
        });
    }
    static async register(req, res) {
        try {
            // Hard-disable via env always wins (deploy-time kill switch).
            if (process.env.DISABLE_REGISTRATION === 'true') {
                return res.status(403).json({ error: 'Registration is disabled.' });
            }
            // Runtime toggle stored in the singleton Settings row.
            const settings = await Settings.getSingleton();
            if (settings.disableRegistration) {
                return res.status(403).json({ error: 'Registration is currently disabled.' });
            }

            // Get userdata from request
            let { email, password } = req.body;

            // Normalize identity boundary: lowercase BEFORE the duplicate-check
            // findOne AND the create, so mixed-case input can never re-split
            // an identity that migration 015 already folded.
            email = String(email || '').toLowerCase();

            // Validate if user data ok. Runs AFTER the lowercase assignment so
            // Joi validates the exact identity that gets persisted — email
            // normalization happens in the model's hooks anyway, and the
            // register test suite asserts the 400 path fires on the validator
            // message regardless of casing.
            const { error } = User.validate({ email, password });
            if (error) {
                return res.status(400).json({ error: error.message });
            }

            // Check if user is already registered
            let user = await User.findOne({ where: { email: email } });
            if (user) {
                return res.status(409).json({ error: 'Registration failed. Please try a different email.' });
            }

            // Save new user to db. First-registered-user bootstrap (plan 099):
            // when no user row exists yet, this account becomes the admin
            // (isAdmin = count === 0). Count and create are not atomic together,
            // so a theoretical simultaneous-registration race could yield two
            // admins — acceptable for a personal deployment.
            const userCount = await User.count();
            user = await User.create({ email: email, password: password, isAdmin: userCount === 0 });

            // Send response
            return res.status(201).json({ ok: true });

        } catch (err) {
            console.error('Error:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getShareId(req, res) {
        try{
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            let shareId = user.shareId;
            res.status(200).send(shareId);
        }
        catch(err) {
            console.error(err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async toggleShareId(req, res) {
        try{
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            let shareId = user.shareId;
            if(!shareId){
                await user.update({ shareId: nanoid() });
            }
            else {
                await user.update({ shareId: null });
            }
            res.sendStatus(200);
        }
        catch(err) {
            console.error(err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    // Public read of site settings (the register/login pages need this to
    // decide whether to surface the signup form). The deploy-time env
    // kill-switch always wins over the runtime toggle, so we OR it in here.
    static async getSettings(req, res) {
        try {
            const settings = await Settings.getSingleton();
            const envDisabled = process.env.DISABLE_REGISTRATION === 'true';
            const body = {
                disableRegistration: settings.disableRegistration || envDisabled,
                tokenFromEnv: runtime.isFromEnv(),
            };
            // isAdmin is derived from the SESSION (never from client input) and
            // only surfaced when authenticated. Anonymous callers (the login and
            // register pages) keep the original two-field public shape.
            if (req.user && req.user.id) {
                body.isAdmin = Boolean(req.user.isAdmin);
            }
            // Authenticated responses embed the session-derived isAdmin, so
            // they are private per-user; only the anonymous two-field shape
            // may be cached in shared caches.
            if (req.user && req.user.id) {
                res.set('Cache-Control', 'private, max-age=30');
            } else {
                res.set('Cache-Control', 'public, max-age=30');
            }
            res.json(body);
        } catch (err) {
            console.error(err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getSettingsFull(req, res) {
        try {
            const settings = await Settings.getSingleton();
            const envDisabled = process.env.DISABLE_REGISTRATION === 'true';
            const extras = {
                disableRegistration: settings.disableRegistration || envDisabled,
            };
            // Same session-derived isAdmin as getSettings: lets the SPA decide
            // whether to render admin-only cards from the full-settings payload.
            if (req.user && req.user.id) {
                extras.isAdmin = Boolean(req.user.isAdmin);
            }
            res.set('Cache-Control', 'private, max-age=30');
            res.json(settingsView(settings, extras));
        } catch (err) {
            console.error(err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    // Authenticated toggle of site settings. ADMIN-ONLY (plan 099): the first
    // registered user is the operator, so only that account may flip the
    // registration toggle, rotate the upload token, or change LLM/vehicle/
    // retention/timezone config. The deploy-time DISABLE_REGISTRATION env var
    // always wins over the runtime toggle.
    static async updateSettings(req, res) {
        try {
            if (!requireAdmin(req, res)) return;
            const { disableRegistration, uploadApiToken } = req.body;
            const envDisabled = process.env.DISABLE_REGISTRATION === 'true';

            const updateData = { id: 1 };

            // disableRegistration is optional — allows PUT with just uploadApiToken
            if (disableRegistration !== undefined) {
                if (typeof disableRegistration !== 'boolean') {
                    return res.status(400).json({ error: 'disableRegistration must be a boolean.' });
                }
                if (envDisabled) {
                    return res.status(403).json({ error: 'Registration is disabled by configuration.' });
                }
                updateData.disableRegistration = disableRegistration;
            }

            // Handle uploadApiToken if provided (string to set, null to clear)
            if (uploadApiToken !== undefined) {
                if (runtime.isFromEnv()) {
                    return res.status(403).json({
                        error: 'Upload API token is managed via the UPLOAD_API_TOKEN environment variable. Unset it to use the app UI.',
                    });
                }
                if (uploadApiToken !== null && typeof uploadApiToken !== 'string') {
                    return res.status(400).json({ error: 'uploadApiToken must be a string or null.' });
                }
                if (typeof uploadApiToken === 'string' && uploadApiToken.length === 0) {
                    return res.status(400).json({ error: 'uploadApiToken must not be empty.' });
                }
                updateData.uploadApiToken = uploadApiToken;
            }

            // LLM config fields
            const { llmProvider, llmApiKey, llmModel, llmEndpoint,
                    vehicleMake, vehicleModel, vehicleYear, engineCc } = req.body;

            if (llmProvider !== undefined) {
              const r = validateProvider(llmProvider);
              if (!r.ok) return res.status(400).json({ error: r.error });
              updateData.llmProvider = llmProvider;
            }
            if (llmModel !== undefined) {
              if (typeof llmModel !== 'string' || llmModel.length > 200) {
                return res.status(400).json({ error: 'llmModel must be a string of at most 200 characters.' });
              }
              updateData.llmModel = llmModel;
            }
            if (llmEndpoint !== undefined) {
              if (llmEndpoint !== null) {
                try { new URL(llmEndpoint); } catch {
                  return res.status(400).json({ error: 'Invalid endpoint URL' });
                }
              }
              updateData.llmEndpoint = llmEndpoint;
            }
            if (vehicleMake !== undefined) updateData.vehicleMake = vehicleMake;
            if (vehicleModel !== undefined) updateData.vehicleModel = vehicleModel;
            if (vehicleYear !== undefined) {
              if (vehicleYear !== null) {
                const y = Number(vehicleYear);
                if (!Number.isInteger(y) || y < 1900 || y > 2099) {
                  return res.status(400).json({ error: 'Vehicle year must be between 1900 and 2099' });
                }
              }
              updateData.vehicleYear = vehicleYear;
            }
            if (engineCc !== undefined) {
              if (engineCc !== null) {
                const c = Number(engineCc);
                if (!Number.isInteger(c) || c < 50 || c > 20000) {
                  return res.status(400).json({ error: 'Engine CC must be between 50 and 20000' });
                }
              }
              updateData.engineCc = engineCc;
            }

            // DeepSeek thinking mode fields
            const { llmThinkingMode, llmReasoningEffort, llmMaxTokens, timezoneOffset } = req.body;

            if (llmThinkingMode !== undefined) {
              const r = validateLlmThinkingMode(llmThinkingMode);
              if (!r.ok) return res.status(400).json({ error: r.error });
              updateData.llmThinkingMode = llmThinkingMode;
            }
            if (llmReasoningEffort !== undefined) {
              if (llmReasoningEffort !== null && !['low', 'medium', 'high', 'max'].includes(llmReasoningEffort)) {
                return res.status(400).json({ error: 'llmReasoningEffort must be low, medium, high, or max.' });
              }
              updateData.llmReasoningEffort = llmReasoningEffort;
            }
            if (llmMaxTokens !== undefined) {
              const r = validateLlmMaxTokens(llmMaxTokens);
              if (!r.ok) return res.status(400).json({ error: r.error });
              updateData.llmMaxTokens = r.value;
            }

            // Timezone offset (minutes from UTC, e.g. 480 for UTC+8)
            if (timezoneOffset !== undefined) {
              const off = Number(timezoneOffset);
              if (!Number.isInteger(off) || off < -720 || off > 840) {
                return res.status(400).json({ error: 'timezoneOffset must be an integer between -720 and 840 (minutes from UTC).' });
              }
              updateData.timezoneOffset = off;
            }

            // Handle retentionEnabled if provided
            if (req.body.retentionEnabled !== undefined) {
              const r = validateRetentionEnabled(req.body.retentionEnabled);
              if (!r.ok) return res.status(400).json({ error: r.error });
              updateData.retentionEnabled = req.body.retentionEnabled;
            }

            // Handle retentionDays if provided
            if (req.body.retentionDays !== undefined) {
              const r = validateRetentionDays(req.body.retentionDays);
              if (!r.ok) return res.status(400).json({ error: r.error });
              updateData.retentionDays = req.body.retentionDays;
            }

            // Handle analysisRetentionDays if provided (nullable: null clears —
            // disables the app-side Analyses prune job). Validated against the
            // same 90-365 window as retentionDays; ONLY reachable behind the
            // admin gate above. No add_retention_policy call — the Analyses
            // prune job (services/analysesRetention.js) reads this value.
            if (req.body.analysisRetentionDays !== undefined) {
              const r = validateAnalysisRetentionDays(req.body.analysisRetentionDays);
              if (!r.ok) return res.status(400).json({ error: r.error });
              updateData.analysisRetentionDays = req.body.analysisRetentionDays;
            }

            // API key requires encryption
            if (llmApiKey !== undefined) {
              if (llmApiKey === null) {
                updateData.llmApiKeyEnc = null;
              } else if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
                const { prepareApiKey } = require('../lib/llmProviders');
                updateData.llmApiKeyEnc = prepareApiKey(llmApiKey);
              }
            }

            await Settings.upsert(updateData);
            Settings.invalidateCache();

            // Keep the runtime holder in sync
            if (uploadApiToken !== undefined) {
                runtime.setUploadApiToken(uploadApiToken);
            }

            // Apply or remove TimescaleDB retention policy
            let policyApplied = false;
            if (updateData.retentionEnabled !== undefined || updateData.retentionDays !== undefined) {
                const settings = await Settings.getSingleton();
                if (settings.retentionEnabled) {
                    // Remove existing policy first (idempotent)
                    await sequelize.query(
                        `SELECT remove_retention_policy('"Logs"', if_exists => true)`
                    ).catch(err => {
                        console.error('[UserController] Failed to remove retention policy:', err.message);
                    });
                    // Apply new policy — parameterized (defense-in-depth, removes
                    // reliance on upstream validation); Number() cast keeps the
                    // replacement binding numeric
                    const [daysResult] = await sequelize.query(
                        `SELECT add_retention_policy('"Logs"', make_interval(days => :days))`,
                        { replacements: { days: Number(settings.retentionDays) } }
                    ).catch(err => {
                        console.error('[UserController] Failed to apply retention policy:', err.message);
                        return [null];
                    });
                    policyApplied = Array.isArray(daysResult) && daysResult.length > 0;
                } else {
                    // Remove policy
                    await sequelize.query(
                        `SELECT remove_retention_policy('"Logs"', if_exists => true)`
                    ).catch(err => {
                        console.error('[UserController] Failed to remove retention policy:', err.message);
                    });
                }
            }

            // Re-fetch the full settings row to return complete state
            const current = await Settings.getSingleton();
            res.json(settingsView(current, {
                disableRegistration: current.disableRegistration || envDisabled,
                retentionPolicyApplied: policyApplied,
            }));
        } catch (err) {
            console.error(err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    // Generate a new upload API token (64 hex chars). Returns the full token
    // to the caller exactly once; subsequent reads via getSettings expose only
    // a Boolean indicating presence. The token is persisted to the Settings row
    // and also held in the runtime in-memory holder for fast rate-limiter checks.
    static async generateUploadToken(req, res) {
        try {
            // Admin-only: rotating the shared upload token locks out every
            // configured Torque client, so only the operator may do it.
            if (!requireAdmin(req, res)) return;
            if (runtime.isFromEnv()) {
                return res.status(403).json({
                    error: 'Upload API token is managed via the UPLOAD_API_TOKEN environment variable. Unset it to use the app UI.',
                });
            }
            const token = crypto.randomBytes(32).toString('hex');
            const settings = await Settings.getSingleton();
            settings.uploadApiToken = token;
            await settings.save();
            runtime.setUploadApiToken(token);
            res.json({ uploadApiToken: token });
        } catch (err) {
            console.error(err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

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

            // Invalidate every OTHER session: deserializeUser compares the tv stored in
            // each client's cookie against this column and rejects mismatches. Bump it
            // AFTER the password update (two separate update() calls keep the beforeUpdate
            // password-hashing hook from re-hashing on this call).
            await user.update({ tokenVersion: (user.tokenVersion || 0) + 1 });

            // Invalidate the deserializeUser cache so the next request re-reads
            // this user from the DB instead of serving a pre-change snapshot.
            userByIdCache.del(user.id);

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
                    return res.json({ ok: true, message: 'Password changed. Your session has been refreshed.' });
                });
            });
        } catch (err) {
            console.error('[UserController]', err.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

// ── Settings projection helper ──────────────────────────────────────────────
// Single source of truth for the settings response shape. Callers pass extras
// (e.g. disableRegistration override, retentionPolicyApplied) via the second
// argument which is spread on top of the base fields.
function settingsView(settings, extras = {}) {
    return {
        disableRegistration: settings.disableRegistration || false,
        hasUploadApiToken: Boolean(settings.uploadApiToken || runtime.isFromEnv()),
        tokenFromEnv: runtime.isFromEnv(),
        hasLlmProvider: Boolean(settings.llmProvider),
        llmProvider: settings.llmProvider || null,
        llmModel: settings.llmModel || null,
        llmEndpoint: settings.llmEndpoint || null,
        hasLlmApiKey: Boolean(settings.llmApiKeyEnc),
        vehicleMake: settings.vehicleMake || null,
        vehicleModel: settings.vehicleModel || null,
        vehicleYear: settings.vehicleYear || null,
        engineCc: settings.engineCc || null,
        llmThinkingMode: settings.llmThinkingMode ?? true,
        llmReasoningEffort: settings.llmReasoningEffort || 'high',
        llmMaxTokens: settings.llmMaxTokens || 16384,
        timezoneOffset: settings.timezoneOffset ?? 0,
        retentionEnabled: settings.retentionEnabled ?? false,
        retentionDays: settings.retentionDays ?? 365,
        analysisRetentionDays: settings.analysisRetentionDays ?? null,
        ...extras,
    };
}

module.exports = UserController;

// Expose the settings projection helper so tests assert against the real
// response shape (single source of truth) instead of local re-implementations.
module.exports.settingsView = settingsView;