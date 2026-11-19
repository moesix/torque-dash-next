-- 027_vehicle_default_unique.sql — make "one default vehicle per user" a
-- database invariant.
--
-- setDefault used to issue two unsequenced writes with no unique index, so a
-- double-click could leave two defaults; the upload hot path then picked an
-- arbitrary row and attributed new trips to the wrong vehicle.
--
-- Dedupe first: keep the lowest-id default per user (the oldest one the user
-- could have chosen) and clear any duplicates left by the old code. This runs
-- once on apply; afterwards the partial index makes duplicates impossible.
UPDATE "Vehicles" v SET "isDefault" = false
WHERE v."isDefault" = true
  AND EXISTS (
    SELECT 1 FROM "Vehicles" d
    WHERE d."userId" = v."userId" AND d."isDefault" = true AND d.id < v.id
  );

CREATE UNIQUE INDEX IF NOT EXISTS "Vehicles_one_default_per_user"
  ON "Vehicles" ("userId") WHERE "isDefault" = true;
