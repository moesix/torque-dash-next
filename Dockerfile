# torque-dash-next backend image
FROM node:20-bookworm-slim

# bcrypt@3 is a native addon compiled at install time, so we need build tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# Boot sequence:
#   1) sync() creates the base tables on first boot (idempotent).
#   2) migrate.js turns "Logs" into a TimescaleDB hypertable + seeds Settings.
#   3) start the API server.
CMD ["sh", "-c", "node -e \"require('./models').sequelize.sync().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);})\" && node scripts/migrate.js && node app.js"]
