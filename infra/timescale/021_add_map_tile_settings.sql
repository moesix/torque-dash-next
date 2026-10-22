-- Map basemap settings (migration 021): admin-configurable tile provider.
-- "tileProvider": 'osm' (Standard OpenStreetMap tiles) is the default
--   KEYLESS provider — no credentials anywhere in the URL chain. 'carto' is
--   the opt-in upgrade (CARTO Voyager / Dark Matter basemaps) and requires
--   the admin's CARTO API key below.
-- "cartoApiKey": the admin's CARTO key. Plain TEXT (like the other Settings
--   config columns); it is deliberately read-for-write purposes in the SPA
--   session: the browser must embed the key in tile request URLs, so
--   GET /api/settings/full surfaces it ONLY while the provider is 'carto'
--   (never when OSM is active, and never in the public unauthenticated
--   /api/settings two-field shape). A blank/missing key leaves the 'carto'
--   choice exposed in full settings but the frontend declines to render
--   CARTO tiles without it.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "tileProvider" VARCHAR(16) NOT NULL DEFAULT 'osm';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "cartoApiKey" TEXT;

-- Allowlist constraint mirroring the Joi enum in lib/validators.js.
-- PostgreSQL has NO "ADD CONSTRAINT IF NOT EXISTS", so — the same workaround
-- 001_log_hypertable.sql documents for unique constraints — we add a fixedly
-- NAMED constraint and let a re-run's duplicate-object error surface in
-- "already exists" form, which scripts/migrate.js treats as benign (skips it).
-- Existing rows are safe to validate: the NOT NULL DEFAULT 'osm' above marks
-- every pre-existing row as a legal 'osm' before this CHECK is added.
-- (Keep to plain statements — scripts/migrate.js splits files on ';' and does
-- not dollar-quote, so DO $$ ... $$ blocks are not usable here.)
ALTER TABLE "Settings" ADD CONSTRAINT settings_tile_provider_check CHECK ("tileProvider" IN ('osm', 'carto'));
