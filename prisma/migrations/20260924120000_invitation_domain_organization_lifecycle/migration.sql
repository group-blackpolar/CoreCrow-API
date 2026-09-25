CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "InvitationKind" AS ENUM ('EMAIL', 'CODE');

ALTER TABLE "Organization"
  ADD COLUMN "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Invitation"
  ADD COLUMN "kind" "InvitationKind" NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN "acceptedByUserId" TEXT,
  ALTER COLUMN "email" DROP NOT NULL;

ALTER TABLE "Invitation"
  ADD CONSTRAINT "Invitation_kind_email_check"
  CHECK (("kind" = 'EMAIL' AND "email" IS NOT NULL) OR ("kind" = 'CODE' AND "email" IS NULL));

CREATE UNIQUE INDEX "Invitation_id_organizationId_key"
  ON "Invitation"("id", "organizationId");
CREATE INDEX "Invitation_organizationId_kind_createdAt_idx"
  ON "Invitation"("organizationId", "kind", "createdAt");

CREATE TABLE "InvitationGroupGrant" (
  "invitationId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationGroupGrant_pkey" PRIMARY KEY ("invitationId", "groupId"),
  CONSTRAINT "InvitationGroupGrant_invitationId_organizationId_fkey"
    FOREIGN KEY ("invitationId", "organizationId")
    REFERENCES "Invitation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InvitationGroupGrant_groupId_organizationId_fkey"
    FOREIGN KEY ("groupId", "organizationId")
    REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "InvitationGroupGrant_organizationId_groupId_idx"
  ON "InvitationGroupGrant"("organizationId", "groupId");

CREATE TABLE "InvitationPermissionGrant" (
  "invitationId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationPermissionGrant_pkey" PRIMARY KEY ("invitationId", "permission"),
  CONSTRAINT "InvitationPermissionGrant_invitationId_organizationId_fkey"
    FOREIGN KEY ("invitationId", "organizationId")
    REFERENCES "Invitation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "InvitationPermissionGrant_organizationId_idx"
  ON "InvitationPermissionGrant"("organizationId");
