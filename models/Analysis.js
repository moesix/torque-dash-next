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
    }, {
        tableName: 'Analyses',
        timestamps: true,
        updatedAt: false,
    });

    return Analysis;
};
