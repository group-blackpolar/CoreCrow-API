-- Operational archive for invitations: hides revoked/expired/accepted rows from the default list without erasing history.
-- Rollback: ALTER TABLE "Invitation" DROP COLUMN "archivedAt";
ALTER TABLE "Invitation" ADD COLUMN "archivedAt" TIMESTAMP(3);
CREATE INDEX "Invitation_organizationId_archivedAt_idx" ON "Invitation"("organizationId", "archivedAt");
