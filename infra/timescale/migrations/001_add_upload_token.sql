-- Add uploadApiToken column to Settings (production upgrade)
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "uploadApiToken" text;
