-- Per-organization defaults and import-history retention. Additive; absent row means built-in defaults.
-- Rollback: DROP TABLE "OrganizationPolicyGroup"; DROP TABLE "OrganizationPolicy";
CREATE TABLE "OrganizationPolicy" (
  "organizationId" TEXT NOT NULL,
  "defaultMemberRole" "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "importRetentionDays" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT,
  CONSTRAINT "OrganizationPolicy_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "OrganizationPolicy_defaultMemberRole_check" CHECK ("defaultMemberRole" IN ('BILLING_ADMIN', 'MEMBER', 'VIEWER')),
  CONSTRAINT "OrganizationPolicy_importRetentionDays_check" CHECK ("importRetentionDays" IS NULL OR ("importRetentionDays" >= 1 AND "importRetentionDays" <= 3650))
);
CREATE TABLE "OrganizationPolicyGroup" (
  "organizationId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  CONSTRAINT "OrganizationPolicyGroup_pkey" PRIMARY KEY ("organizationId", "groupId")
);
CREATE INDEX "OrganizationPolicyGroup_groupId_organizationId_idx" ON "OrganizationPolicyGroup"("groupId", "organizationId");
ALTER TABLE "OrganizationPolicy" ADD CONSTRAINT "OrganizationPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationPolicyGroup" ADD CONSTRAINT "OrganizationPolicyGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "OrganizationPolicy"("organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationPolicyGroup" ADD CONSTRAINT "OrganizationPolicyGroup_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
