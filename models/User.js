const Joi = require('joi');
const bcrypt = require('bcrypt');


module.exports = (sequelize, DataTypes) => {
    const User = sequelize.define('User', {
        email: {
            type: DataTypes.STRING,
            unique: true,
            allowNull: false,
        },
        password: {
            type: DataTypes.STRING,
            allowNull: false
        },
        shareId: {
            type: DataTypes.STRING,
            unique: true
        },
        tokenVersion: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            allowNull: false,
        },
        // Plan 099: the first registered user is the admin. Set at register time
        // (bootstrap: isAdmin = count === 0) and read from the DB row on every
        // authenticated request — never trusted from the session cookie.
        isAdmin: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        forwardUrls: {
            type: DataTypes.ARRAY(DataTypes.STRING)
        }
    }, {
        hooks: {
            beforeCreate: [hashPassword, normalizeEmail],
            beforeUpdate: [hashPassword, normalizeEmail],
        }
    }
    );
    // create association
    User.associate = function (models) {
        User.hasMany(models.Session, {
            as: 'Sessions',
            foreignKey: 'userId',
            onDelete: 'cascade'
        });
        User.hasMany(models.Vehicle, {
            as: 'Vehicles',
            foreignKey: 'userId',
            onDelete: 'cascade'
        });
    };

    // Static method for user data validation
    User.validate = function(user) {
        const schema = {
            email: Joi.string().required().email().error(new Error('Please provide a valid email.')),
            password: Joi.string().min(8).required(),
            confirmPassword: Joi.string().valid(Joi.ref('password')).optional().error(new Error('Passwords do not match.'))
        }
        return Joi.object(schema).validate(user);
    }

    // Instance method for password comparison
    User.prototype.comparePassword = async function(password) {
        return await bcrypt.compare(password, this.password)
    }

    return User;
}
    
async function hashPassword (user) {
    // Only hash if password was actually changed (avoids re-hashing on other updates)
    if (!user.changed('password')) return;

    const SALT_FACTOR = 10;  // OWASP recommends minimum 10
    const salt = await bcrypt.genSalt(SALT_FACTOR);
    let hash = await bcrypt.hash(user.password, salt);
    await user.setDataValue('password', hash);
}

// Normalize the identity boundary: emails are always stored lowercase so
// lookups (login, upload resolveUser, register dup-check) match migration
// 015's folded rows. Runs after hashPassword in both create/update chains.
async function normalizeEmail (user) {
    if (user.changed('email') && user.email) {
        user.email = user.email.toLowerCase();
    }
}