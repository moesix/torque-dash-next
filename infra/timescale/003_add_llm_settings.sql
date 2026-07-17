ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "llmProvider" text;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "llmApiKeyEnc" text;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "llmModel" text;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "llmEndpoint" text;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "vehicleMake" text;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "vehicleModel" text;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "vehicleYear" integer;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "engineCc" integer;
