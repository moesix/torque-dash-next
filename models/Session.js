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
        }
    }, {});

    Session.associate = function (models) {
        Session.hasMany(models.Log, {
            as: 'Logs',
            foreignKey: { name: 'sessionId'},
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