const User = require('../models').User;
const Settings = require('../models').Settings;
const passport = require('passport');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const runtime = require('../config/runtime');

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
    static logout(req, res) {
        req.logout((err) => {
            if (err) return res.status(500).json({ error: 'Logout failed' });
            return res.json({ ok: true });
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

            // Validate if user data ok
            const { error } = User.validate(req.body);
            if (error) {
                return res.status(400).json({ error: error.message });
            }

            // Check if user is already registered
            let user = await User.findOne({ where: { email: email } });
            if (user) {
                return res.status(400).json({ error: 'This email is already registered' });
            }

            // Save new user to db
            user = await User.create({ email: email, password: password });

            // Send response
            return res.status(201).json({ ok: true });

        } catch (err) {
            console.error('Error:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getForwardUrls(req, res) {
        try{
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            let forwardUrls = user.forwardUrls;
            console.log(forwardUrls);
            if(!forwardUrls) return res.send([]);
            res.send(forwardUrls);
        }
        catch(err) {
            console.log(err);
            res.sendStatus(500);
        }
    }
    static async updateForwardUrls(req, res) {
        try{
            let urls = req.body.urls;
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            if(!urls) {
                await user.update({
                    forwardUrls: null
                });
                return res.sendStatus(200);
            }
            await user.update({
                forwardUrls: urls
            });
            res.sendStatus(200);
        }
        catch(err) {
            console.log(err);
            res.sendStatus(500);
        }
    }
    static async getShareId(req, res) {
        try{
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            let shareId = user.shareId;
            console.log(shareId);
            res.status(200).send(shareId);
        }
        catch(err) {
            console.log(err);
            res.sendStatus(500);
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
            console.log(err);
            res.sendStatus(500);
        }
    }
    // Public read of site settings (the register/login pages need this to
    // decide whether to surface the signup form). The deploy-time env
    // kill-switch always wins over the runtime toggle, so we OR it in here.
    static async getSettings(req, res) {
        try {
            const settings = await Settings.getSingleton();
            const envDisabled = process.env.DISABLE_REGISTRATION === 'true';
            res.json({
                disableRegistration: settings.disableRegistration || envDisabled,
                hasUploadApiToken: Boolean(settings.uploadApiToken || runtime.isFromEnv()),
                tokenFromEnv: runtime.isFromEnv(),
            });
        } catch (err) {
            console.log(err);
            res.sendStatus(500);
        }
    }
    // Authenticated toggle of site settings. NOTE: the app is single-operator,
    // so ANY authenticated user is treated as an operator and may flip this.
    // The deploy-time DISABLE_REGISTRATION env var always wins over this toggle.
    static async updateSettings(req, res) {
        try {
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

            await Settings.upsert(updateData);

            // Keep the runtime holder in sync
            if (uploadApiToken !== undefined) {
                runtime.setUploadApiToken(uploadApiToken);
            }

            // Determine state for the response, OR-ing with env overrides
            const [currentSettings] = await Settings.findOrCreate({
                where: { id: 1 },
                defaults: { disableRegistration: false, uploadApiToken: null },
            });
            const finalDisabled = disableRegistration !== undefined
                ? (disableRegistration || envDisabled)
                : (currentSettings.disableRegistration || envDisabled);
            const hasUploadApiToken = uploadApiToken !== undefined
                ? Boolean(uploadApiToken)
                : Boolean(currentSettings.uploadApiToken);

            res.json({ disableRegistration: finalDisabled, hasUploadApiToken });
        } catch (err) {
            console.log(err);
            res.sendStatus(500);
        }
    }
    // Generate a new upload API token (64 hex chars). Returns the full token
    // to the caller exactly once; subsequent reads via getSettings expose only
    // a Boolean indicating presence. The token is persisted to the Settings row
    // and also held in the runtime in-memory holder for fast rate-limiter checks.
    static async generateUploadToken(req, res) {
        try {
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
            console.log(err);
            res.sendStatus(500);
        }
    }
}

module.exports = UserController;