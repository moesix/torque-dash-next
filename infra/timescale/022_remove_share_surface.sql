-- 022_remove_share_surface.sql
-- The share-link surface was removed in code (fork carry-over from upstream;
-- the SPA never consumed it). Drop the credential column and its index.
--
-- Fresh-install ordering: 013_users_sessions_baseline.sql no longer creates
-- "shareId" (or its unique index) at all — on a brand-new database where
-- sequelize.sync() built "Users" from the current model, the old index DDL
-- failed with "column shareId does not exist" and aborted the whole migration
-- run. So these drops are purely for PRE-EXISTING databases: on a fresh one
-- they are no-ops (IF EXISTS), on an existing one they clean up the column.
-- Idempotent either way, which is why re-running 022 is safe.
--
-- Sync-created databases model shareId as a UNIQUE CONSTRAINT (not a bare
-- index); dropping an index owned by a constraint is refused, so drop the
-- constraint first (no-op where it never existed, e.g. migration-created
-- databases and CI).
ALTER TABLE "Users" DROP CONSTRAINT IF EXISTS "Users_shareId_key";
DROP INDEX IF EXISTS "Users_shareId_key";
ALTER TABLE "Users" DROP COLUMN IF EXISTS "shareId";
