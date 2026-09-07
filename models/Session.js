module.exports = (sequelize, DataTypes) => {
    // define Session
    const Session = sequelize.define('Session', {
        sessionId : {
            type: DataTypes.STRING,
            unique: true
        },
        name: {
            type: DataTypes.STRING,
            defaultValue: 'Unnamed session'
        },
        startLocation: {
            type: DataTypes.STRING,
            defaultValue: '-'
        },
        endLocation: {
            type: DataTypes.STRING,
            defaultValue: '-'
        },
        notes: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        vehicleId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
        firstTimestamp: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: null,
        },
        lastTimestamp: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: null,
        },
        maxRpm: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
        maxSpeed: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        }
    }, {});

    Session.associate = function (models) {
        Session.hasMany(models.Log, {
            as: 'Logs',
            foreignKey: { name: 'sessionId'},
            onDelete: 'cascade'
        });
        // Dev-sync parity with migration 004's "sessionId" integer NOT NULL
        // REFERENCES "Sessions"(id) ON DELETE CASCADE: non-prod builds run
        // sequelize.sync() from these models, and without this hasMany the
        // generated Analyses FK would have no cascade, orphaning Analyses on
        // session deletion in dev while prod deletes them. Production schema is
        // owned by the migrations, so this only shapes dev/test sync.
        Session.hasMany(models.Analysis, {
            as: 'Analyses',
            foreignKey: 'sessionId',
            onDelete: 'cascade'
        });
        Session.belongsTo(models.User, {
            foreignKey: 'userId',
        });
        Session.belongsTo(models.Vehicle, {
            as: 'Vehicle',
            foreignKey: { name: 'vehicleId', allowNull: true },
            onDelete: 'set null',
        });
    };

    return Session;
};