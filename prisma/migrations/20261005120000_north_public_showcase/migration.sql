-- Public showcase: explicit, revocable, additive publication policy.
-- Defaults keep every existing organization and panel private.
CREATE TYPE "NorthPanelVisibility" AS ENUM ('PRIVATE', 'SHOWCASE');

ALTER TABLE "Organization" ADD COLUMN "showcaseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NorthPanel" ADD COLUMN "visibility" "NorthPanelVisibility" NOT NULL DEFAULT 'PRIVATE';

CREATE INDEX "NorthPanel_org_visibility_status_idx"
  ON "NorthPanel"("organizationId", "visibility", "status")
  WHERE "visibility" = 'SHOWCASE';
