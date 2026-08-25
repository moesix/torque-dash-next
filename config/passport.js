const LocalStrategy = require('passport-local');
const User = require('../models').User;
const { UserCache } = require('../lib/userCache');

// TTL cache for deserializeUser's DB hit. Kept SHORT (60s) so credential
// changes bound staleness even before explicit invalidation. Negative
// results are stored as null so unknown ids skip the DB too. CRITICAL: the
// tokenVersion comparison ALWAYS runs against whatever user object we have
// (cached or fresh), so a bumped tokenVersion still rejects stale sessions
// even when served from this cache.
const userByIdCache = new UserCache({ ttl: 60_000, max: 1000 });

module.exports = function(passport){
    passport.use(
        new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
            // Search if user in db
            let user;
            try{
                user = await User.findOne({ where: { email: email.toLowerCase() }})
                if(!user){
                    return done(null, false, { message: 'Incorrect username or password.' });
                }
                
                // Compare password
                let isMatch = await user.comparePassword(password);
                if(isMatch){
                    return done(null, user);
                }
                else{
                    return done(null, false, { message: 'Incorrect username or password.' });
                }
            }
            catch(err){ 
                console.error(err);
                return done(err, false);
            }
        })
    );

    // called when user logs in, stores user id + tokenVersion in cookie
    passport.serializeUser((user, done) => {
        done(null, { id: user.id, tv: user.tokenVersion || 0 });
    });
    
    // called when request from client is made, loads user data into req.user based on cookie's user id + tokenVersion
    passport.deserializeUser(async (session, done) => {
        try{
            const id = session.id;
            let user = userByIdCache.get(id);
            if (user === undefined) { // not cached (absent or expired)
                user = await User.findByPk(id);
                userByIdCache.set(id, user || null); // negative-cache misses too
            }
            if(!user){
                done(null, false);
                return;
            }
            // Check tokenVersion to invalidate stale sessions (e.g. after password
            // change). Enforced on EVERY path — cache hit or fresh DB read — so a
            // bumped tokenVersion rejects old sessions within the TTL window.
            const userTv = user.tokenVersion || 0;
            const sessionTv = session.tv || 0;
            if (userTv !== sessionTv) {
                return done(null, false);
            }
            done(null, user.get ? user.get() : user);
        }catch(err) {
            console.error(err);
            done(err, false);
        }
    });
}

// Exposed so UserController.changePassword can invalidate the entry for the
// affected user immediately after a credential change.
module.exports.userByIdCache = userByIdCache;