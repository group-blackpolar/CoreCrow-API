ALTER TYPE "TenantRole" ADD VALUE IF NOT EXISTS 'BILLING_ADMIN';

BEGIN;

CREATE UNIQUE INDEX "Membership_id_organizationId_key"
ON "Membership"("id", "organizationId");

CREATE TABLE "OrganizationGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationGroupMember" (
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationGroupMember_pkey" PRIMARY KEY ("groupId", "membershipId")
);

CREATE TABLE "GroupPermissionGrant" (
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupPermissionGrant_pkey" PRIMARY KEY ("groupId", "permission")
);

CREATE TABLE "MembershipPermissionGrant" (
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MembershipPermissionGrant_pkey" PRIMARY KEY ("membershipId", "permission")
);

CREATE UNIQUE INDEX "OrganizationGroup_organizationId_name_key"
ON "OrganizationGroup"("organizationId", "name");
CREATE UNIQUE INDEX "OrganizationGroup_id_organizationId_key"
ON "OrganizationGroup"("id", "organizationId");
CREATE INDEX "OrganizationGroup_organizationId_idx"
ON "OrganizationGroup"("organizationId");
CREATE INDEX "OrganizationGroupMember_organizationId_membershipId_idx"
ON "OrganizationGroupMember"("organizationId", "membershipId");
CREATE INDEX "GroupPermissionGrant_organizationId_idx"
ON "GroupPermissionGrant"("organizationId");
CREATE INDEX "MembershipPermissionGrant_organizationId_idx"
ON "MembershipPermissionGrant"("organizationId");

ALTER TABLE "OrganizationGroup" ADD CONSTRAINT "OrganizationGroup_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite tenant keys make cross-organization group membership and grants
-- impossible even if application validation regresses.
ALTER TABLE "OrganizationGroupMember" ADD CONSTRAINT "OrganizationGroupMember_groupId_organizationId_fkey"
FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationGroupMember" ADD CONSTRAINT "OrganizationGroupMember_membershipId_organizationId_fkey"
FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupPermissionGrant" ADD CONSTRAINT "GroupPermissionGrant_groupId_organizationId_fkey"
FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipPermissionGrant" ADD CONSTRAINT "MembershipPermissionGrant_membershipId_organizationId_fkey"
FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
