-- Create Vehicles table
CREATE TABLE IF NOT EXISTS "Vehicles" (
    "id" SERIAL PRIMARY KEY,
    "name" VARCHAR(255) NOT NULL DEFAULT 'My Vehicle',
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "engineCc" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "userId" INTEGER NOT NULL REFERENCES "Users" ("id") ON DELETE CASCADE,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedAt" TIMESTAMP WITH TIME ZONE
);

-- Add vehicleId FK to Sessions
ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "vehicleId" INTEGER REFERENCES "Vehicles" ("id") ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS "Sessions_vehicleId_idx" ON "Sessions" ("vehicleId");
CREATE INDEX IF NOT EXISTS "Vehicles_userId_idx" ON "Vehicles" ("userId");
