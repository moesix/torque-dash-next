module.exports = (sequelize, DataTypes) => {
    const Vehicle = sequelize.define('Vehicle', {
        name: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: 'My Vehicle',
        },
        make: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        model: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        year: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
        engineCc: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
        isDefault: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
    }, {});

    Vehicle.associate = function (models) {
        Vehicle.belongsTo(models.User, {
            as: 'User',
            foreignKey: 'userId',
        });
        Vehicle.hasMany(models.Session, {
            as: 'Sessions',
            foreignKey: { name: 'vehicleId', allowNull: true },
            onDelete: 'set null',
        });
    };

    return Vehicle;
};
