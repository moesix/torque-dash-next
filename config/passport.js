const LocalStrategy = require('passport-local');
const User = require('../models').User;

module.exports = function(passport){
    passport.use(
        new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
            // Search if user in db
            let user;
            try{
                user = await User.findOne({ where: { email: email }}) 
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
            let user = await User.findByPk(session.id);
            if(user){
                // Check tokenVersion to invalidate stale sessions (e.g. after password change)
                const userTv = user.tokenVersion || 0;
                const sessionTv = session.tv || 0;
                if (userTv !== sessionTv) {
                    return done(null, false);
                }
                done(null, user.get());
            }
            else{
                done(null, false);
            }
        }catch(err) {
            console.error(err);
            done(err, false);
        }
    });
}