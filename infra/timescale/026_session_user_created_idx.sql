-- Session list: WHERE "userId" = ? ORDER BY "createdAt" DESC, plus COUNT(*).
-- Previously only sessionId (unique) and vehicleId were indexed.
CREATE INDEX IF NOT EXISTS "Sessions_userId_createdAt_idx"
  ON "Sessions" ("userId", "createdAt" DESC);
