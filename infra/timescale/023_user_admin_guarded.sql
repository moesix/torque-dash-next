-- 023_user_admin_guarded.sql — idempotent promotion for fresh installs.
-- 017's unconditional UPDATE (lowest-id user) is superseded for re-runs.
UPDATE "Users" SET "isAdmin" = TRUE
WHERE "id" = (SELECT MIN("id") FROM "Users")
  AND NOT EXISTS (SELECT 1 FROM "Users" WHERE "isAdmin");
