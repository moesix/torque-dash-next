ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "llmThinkingMode" boolean DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "llmReasoningEffort" text DEFAULT 'high';
