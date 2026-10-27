-- 022_remove_share_surface.sql
-- The share-link surface was removed in code (fork carry-over from upstream;
-- the SPA never consumed it). Drop the credential column and its index.
--
-- Fresh-install ordering: 013_users_sessions_baseline.sql still creates
-- "Users" WITH "shareId" and its unique index; this migration then drops both,
-- so a brand-new database ends with the correct schema. 013 is an applied
-- migration and must NOT be edited (see Plan 005's applied-file rule).
DROP INDEX IF EXISTS "Users_shareId_key";
ALTER TABLE "Users" DROP COLUMN IF EXISTS "shareId";
