const pidNames = require('../torquekeys');
const util = require('../util/util');

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
            // convert keys to names when pulling out of db
            get: function()  {
                var values = this.getDataValue('values'); 
                values = util.renameKeys(pidNames, values);
                return values;
              },
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
