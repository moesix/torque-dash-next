-- Plan 099: the first registered user is the admin.
--
-- Adds an isAdmin flag to Users. New accounts are non-admin by default; the
-- bootstrap rule in UserController.register promotes the FIRST registered user
-- (count === 0) at create time.
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill for UPGRADED deployments: existing users predate the bootstrap
-- rule, so none would carry isAdmin=true and the operator would lose admin
-- access after upgrading. Promote the lowest-id user (the deployment's
-- original/first account) so the operator keeps admin-only controls.
-- Idempotent: re-running simply re-promotes the same account.
UPDATE "Users" SET "isAdmin" = TRUE
WHERE "id" = (SELECT MIN("id") FROM "Users");
