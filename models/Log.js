module.exports = (sequelize, DataTypes) => {
    // define Log
    const Log = sequelize.define('Log', {
        timestamp: {
            type: DataTypes.DATE
        },
        lon : {
            type: DataTypes.FLOAT
        },
        lat: {
            type: DataTypes.FLOAT
        },
        values: {
            type: DataTypes.JSONB,
            // NOTE: The raw Torque hex keys (k5, kc, kd, kff1007, etc.) are
            // returned as-is to the frontend. The pidDecode engine handles
            // key→name resolution via FALLBACK_MAP + Torque metadata enrichment.
            // The legacy renameKeys getter was removed because it transformed
            // k* keys into full names, breaking the frontend PID discovery.
        },
        // Promoted hot columns (Tier-2 TimescaleDB optimization).
        // `paranoid` is intentionally NOT added — Log keeps no deletedAt column.
        engine_rpm: {
            type: DataTypes.FLOAT,
            allowNull: true
        },
        vehicle_speed: {
            type: DataTypes.FLOAT,
            allowNull: true
        }
    }, {});

    return Log;
};
