-- Access templates and the primary group of an account. Additive.
-- Rollback: DROP TABLE "AccessTemplateGroup"; DROP TABLE "AccessTemplateDataset"; DROP TABLE "AccessTemplate"; DROP INDEX "OrganizationGroupMember_one_primary_idx"; ALTER TABLE "OrganizationGroupMember" DROP COLUMN "isPrimary";
ALTER TABLE "OrganizationGroupMember" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "OrganizationGroupMember_one_primary_idx" ON "OrganizationGroupMember"("membershipId") WHERE "isPrimary";
CREATE TABLE "AccessTemplate" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "role" "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT,
  CONSTRAINT "AccessTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccessTemplate_role_check" CHECK ("role" IN ('ADMIN', 'BILLING_ADMIN', 'MEMBER', 'VIEWER'))
);
CREATE UNIQUE INDEX "AccessTemplate_organizationId_name_key" ON "AccessTemplate"("organizationId", "name");
CREATE UNIQUE INDEX "AccessTemplate_id_organizationId_key" ON "AccessTemplate"("id", "organizationId");
CREATE TABLE "AccessTemplateDataset" ("templateId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "datasetId" TEXT NOT NULL, CONSTRAINT "AccessTemplateDataset_pkey" PRIMARY KEY ("templateId", "datasetId"));
CREATE INDEX "AccessTemplateDataset_datasetId_organizationId_idx" ON "AccessTemplateDataset"("datasetId", "organizationId");
CREATE TABLE "AccessTemplateGroup" ("templateId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "groupId" TEXT NOT NULL, CONSTRAINT "AccessTemplateGroup_pkey" PRIMARY KEY ("templateId", "groupId"));
CREATE INDEX "AccessTemplateGroup_groupId_organizationId_idx" ON "AccessTemplateGroup"("groupId", "organizationId");
ALTER TABLE "AccessTemplate" ADD CONSTRAINT "AccessTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessTemplateDataset" ADD CONSTRAINT "AccessTemplateDataset_template_fkey" FOREIGN KEY ("templateId", "organizationId") REFERENCES "AccessTemplate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessTemplateDataset" ADD CONSTRAINT "AccessTemplateDataset_dataset_fkey" FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessTemplateGroup" ADD CONSTRAINT "AccessTemplateGroup_template_fkey" FOREIGN KEY ("templateId", "organizationId") REFERENCES "AccessTemplate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessTemplateGroup" ADD CONSTRAINT "AccessTemplateGroup_group_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
