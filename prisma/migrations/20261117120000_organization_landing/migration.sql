-- ADR 027: configurable organization landing. Additive: one enum, two tables. Organizations without a row keep today's behaviour.
-- Rollback: DROP TABLE "OrganizationLandingRule"; DROP TABLE "OrganizationLanding"; DROP TYPE "OrganizationLandingMode";
CREATE TYPE "OrganizationLandingMode" AS ENUM ('STANDARD', 'PANEL', 'NONE');

CREATE TABLE "OrganizationLanding" (
    "organizationId" TEXT NOT NULL,
    "mode" "OrganizationLandingMode" NOT NULL DEFAULT 'STANDARD',
    "defaultPanelId" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationLanding_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "OrganizationLanding_panel_mode_check" CHECK (("mode" = 'PANEL') = ("defaultPanelId" IS NOT NULL))
);

CREATE TABLE "OrganizationLandingRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "role" "TenantRole",
    "groupId" TEXT,
    "panelId" TEXT NOT NULL,
    CONSTRAINT "OrganizationLandingRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrganizationLandingRule_one_audience_check" CHECK (("role" IS NULL) <> ("groupId" IS NULL))
);

CREATE INDEX "OrganizationLandingRule_organizationId_idx" ON "OrganizationLandingRule"("organizationId");
CREATE UNIQUE INDEX "OrganizationLandingRule_organizationId_order_key" ON "OrganizationLandingRule"("organizationId", "order");
-- One rule per role and per group per organization.
CREATE UNIQUE INDEX "OrganizationLandingRule_organizationId_role_key" ON "OrganizationLandingRule"("organizationId", "role") WHERE "role" IS NOT NULL;
CREATE UNIQUE INDEX "OrganizationLandingRule_organizationId_groupId_key" ON "OrganizationLandingRule"("organizationId", "groupId") WHERE "groupId" IS NOT NULL;

ALTER TABLE "OrganizationLanding" ADD CONSTRAINT "OrganizationLanding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationLandingRule" ADD CONSTRAINT "OrganizationLandingRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The database enforces the tenant match of the referenced panel / group (composite keys already unique on both tables).
ALTER TABLE "OrganizationLanding" ADD CONSTRAINT "OrganizationLanding_panel_same_tenant_fkey" FOREIGN KEY ("defaultPanelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE RESTRICT;
ALTER TABLE "OrganizationLandingRule" ADD CONSTRAINT "OrganizationLandingRule_panel_same_tenant_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE RESTRICT;
ALTER TABLE "OrganizationLandingRule" ADD CONSTRAINT "OrganizationLandingRule_group_same_tenant_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE; -- deleting a group retires its rule
