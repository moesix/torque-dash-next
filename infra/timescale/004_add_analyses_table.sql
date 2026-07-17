CREATE TABLE IF NOT EXISTS "Analyses" (
    id serial PRIMARY KEY,
    "sessionId" integer NOT NULL REFERENCES "Sessions"(id) ON DELETE CASCADE,
    "userId" integer NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
    provider text NOT NULL,
    model text NOT NULL,
    prompt text NOT NULL,
    response text NOT NULL,
    "tokenUsage" jsonb,
    "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analyses_session ON "Analyses"("sessionId");
CREATE INDEX IF NOT EXISTS idx_analyses_user ON "Analyses"("userId");
CREATE INDEX IF NOT EXISTS idx_analyses_created ON "Analyses"("createdAt" DESC);
