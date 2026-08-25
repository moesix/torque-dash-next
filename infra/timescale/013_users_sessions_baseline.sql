-- Users and Sessions baseline DDL for sync-less databases.
-- Every statement is idempotent (IF NOT EXISTS) — on databases where
-- sequelize.sync() already created these tables, each statement is a
-- benign skip.

-- Users table (matches models/User.js)
CREATE TABLE IF NOT EXISTS "Users" (
    id SERIAL PRIMARY KEY,
    email VARCHAR NOT NULL,
    password VARCHAR NOT NULL,
    "shareId" VARCHAR,
    "forwardUrls" TEXT[],
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraints via CREATE INDEX (avoids collisions with sync-created indexes)
CREATE UNIQUE INDEX IF NOT EXISTS "Users_email_key" ON "Users" (email);
CREATE UNIQUE INDEX IF NOT EXISTS "Users_shareId_key" ON "Users" ("shareId");

-- Sessions table (matches models/Session.js)
CREATE TABLE IF NOT EXISTS "Sessions" (
    id SERIAL PRIMARY KEY,
    "sessionId" VARCHAR,
    name VARCHAR(255) NOT NULL DEFAULT 'Unnamed session',
    "startLocation" VARCHAR DEFAULT '-',
    "endLocation" VARCHAR DEFAULT '-',
    notes TEXT,
    "vehicleId" INTEGER,
    "userId" INTEGER REFERENCES "Users"(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ
);

-- Unique constraint on sessionId
CREATE UNIQUE INDEX IF NOT EXISTS "Sessions_sessionId_key" ON "Sessions" ("sessionId");
