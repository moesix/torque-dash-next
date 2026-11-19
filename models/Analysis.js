const { DataTypes } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    const Analysis = sequelize.define('Analysis', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        sessionId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        provider: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        model: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        prompt: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        response: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        tokenUsage: {
            type: DataTypes.JSONB,
            allowNull: true,
        },
        reasoning: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        // Descriptive metadata: the unit system the prose was generated in.
        // NULL = unknown (historical rows). Not used to render the prose.
        unitSystem: {
            type: DataTypes.STRING(16),
            allowNull: true,
        },
    }, {
        tableName: 'Analyses',
        timestamps: true,
        updatedAt: false,
    });

    Analysis.associate = function (models) {
        Analysis.belongsTo(models.Session, { foreignKey: 'sessionId', as: 'Session' });
    };

    return Analysis;
};
