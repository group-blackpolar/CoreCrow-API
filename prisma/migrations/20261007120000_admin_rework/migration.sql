-- Organization icon and multi-use invitation keys.
ALTER TABLE "Organization" ADD COLUMN "iconData" TEXT;
ALTER TABLE "Invitation"
  ADD COLUMN "tokenHint" TEXT,
  ADD COLUMN "maxUses" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "useCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "createdByUserId" TEXT;
-- Invitations accepted before this migration were single-use and are already exhausted.
UPDATE "Invitation" SET "useCount" = 1 WHERE "acceptedAt" IS NOT NULL;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_maxUses_check" CHECK ("maxUses" BETWEEN 1 AND 1000);
