-- Plan 120: retire the forwardUrls webhook fan-out surface (owner decision).
--
-- No UI, no discoverability, no user; the SSRF-guarded fire-and-forget copy of
-- every upload is removed. The SSRF guard (lib/ssrfGuard.js) itself stays —
-- it still protects the BYOK custom-endpoint LLM path (lib/llmProviders.js).
-- Idempotent: DROP COLUMN IF EXISTS.
ALTER TABLE "Users" DROP COLUMN IF EXISTS "forwardUrls";
