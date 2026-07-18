-- Add reasoning column to Analyses (DeepSeek reasoning model support)
ALTER TABLE "Analyses" ADD COLUMN IF NOT EXISTS "reasoning" text;
