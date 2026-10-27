-- 023_user_admin_guarded.sql — idempotent promotion for fresh installs.
-- Adds a guard after 017: 017's unconditional UPDATE (lowest-id user) would
-- otherwise re-promote on re-runs; promote only when no admin exists yet.
UPDATE "Users" SET "isAdmin" = TRUE
WHERE "id" = (SELECT MIN("id") FROM "Users")
  AND NOT EXISTS (SELECT 1 FROM "Users" WHERE "isAdmin");
