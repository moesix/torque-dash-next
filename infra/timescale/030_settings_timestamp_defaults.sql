-- 030: Settings timestamps exist on every supported schema shape after 025.
-- Give them DB defaults so no INSERT has to supply them. Idempotent.
ALTER TABLE "Settings" ALTER COLUMN "createdAt" SET DEFAULT NOW();
ALTER TABLE "Settings" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
