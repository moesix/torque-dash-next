const { DataTypes } = require('sequelize');

/**
 * Singleton site settings. A single row (id = 1) holds global flags so the
 * SPA can read/toggle them without a dedicated admin table. `disableRegistration`
 * lets an operator hard-close public signups at runtime (env DISABLE_REGISTRATION
 * is the deploy-time equivalent that always wins).
 */
module.exports = (sequelize, DataTypes) => {
    const Settings = sequelize.define('Settings', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            defaultValue: 1,
        },
        disableRegistration: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        uploadApiToken: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },

        // ── LLM / Vehicle columns (migration 003) ────────────────────────
        llmProvider: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        llmApiKeyEnc: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        llmModel: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        llmEndpoint: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        vehicleMake: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        vehicleModel: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
        },
        vehicleYear: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
        engineCc: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
    });

    // Resolve the singleton row, creating it on first access.
    Settings.getSingleton = async function () {
        const [row] = await Settings.findOrCreate({
            where: { id: 1 },
            defaults: {
                disableRegistration: false,
                uploadApiToken: null,
                llmProvider: null,
                llmApiKeyEnc: null,
                llmModel: null,
                llmEndpoint: null,
                vehicleMake: null,
                vehicleModel: null,
                vehicleYear: null,
                engineCc: null,
            },
        });
        return row;
    };

    return Settings;
};
