-- CreateEnum
CREATE TYPE "NorthScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'PERSONAL');

-- CreateEnum
CREATE TYPE "NorthResourceKind" AS ENUM ('SYSTEM', 'CONTENT');

-- CreateEnum
CREATE TYPE "NorthCategoryClass" AS ENUM ('SYSTEM', 'TEMPLATE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "NorthResourceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "NorthPanelStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "NorthPermissionScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'CATEGORY', 'SUBCATEGORY', 'PANEL');

-- CreateEnum
CREATE TYPE "NorthAudienceType" AS ENUM ('ALL_MEMBERS', 'ROLES', 'GROUPS', 'PERMISSIONS', 'SPECIFIC_USERS');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "homePanelId" TEXT;

-- CreateTable
CREATE TABLE "NorthCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "scope" "NorthScope" NOT NULL,
    "resourceKind" "NorthResourceKind" NOT NULL,
    "categoryClass" "NorthCategoryClass" NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "icon" TEXT,
    "color" TEXT,
    "slug" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "navigationHidden" BOOLEAN NOT NULL DEFAULT false,
    "status" "NorthResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceTemplateId" TEXT,
    "sourceTemplateVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NorthCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NorthSubcategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "resourceKind" "NorthResourceKind" NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "icon" TEXT,
    "color" TEXT,
    "slug" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "navigationHidden" BOOLEAN NOT NULL DEFAULT false,
    "status" "NorthResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NorthSubcategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NorthPanel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subcategoryId" TEXT NOT NULL,
    "resourceKind" "NorthResourceKind" NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "icon" TEXT,
    "color" TEXT,
    "slug" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "navigationHidden" BOOLEAN NOT NULL DEFAULT false,
    "status" "NorthPanelStatus" NOT NULL DEFAULT 'DRAFT',
    "audienceType" "NorthAudienceType" NOT NULL DEFAULT 'ALL_MEMBERS',
    "publishedRevisionId" TEXT,
    "draftRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NorthPanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NorthCategorySlugAlias" (
    "categoryId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthCategorySlugAlias_pkey" PRIMARY KEY ("organizationId","slug")
);

-- CreateTable
CREATE TABLE "NorthSubcategorySlugAlias" (
    "subcategoryId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthSubcategorySlugAlias_pkey" PRIMARY KEY ("categoryId","slug")
);

-- CreateTable
CREATE TABLE "NorthPanelSlugAlias" (
    "panelId" TEXT NOT NULL,
    "subcategoryId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthPanelSlugAlias_pkey" PRIMARY KEY ("subcategoryId","slug")
);

-- CreateTable
CREATE TABLE "NorthPlatformGrant" (
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthPlatformGrant_pkey" PRIMARY KEY ("userId","capability")
);

-- CreateTable
CREATE TABLE "NorthRoleGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "capability" TEXT NOT NULL,
    "scope" "NorthPermissionScope" NOT NULL,
    "categoryId" TEXT,
    "subcategoryId" TEXT,
    "panelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthRoleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NorthGroupGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scope" "NorthPermissionScope" NOT NULL,
    "categoryId" TEXT,
    "subcategoryId" TEXT,
    "panelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthGroupGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NorthMembershipGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scope" "NorthPermissionScope" NOT NULL,
    "categoryId" TEXT,
    "subcategoryId" TEXT,
    "panelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthMembershipGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NorthPanelAudienceRole" (
    "organizationId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,

    CONSTRAINT "NorthPanelAudienceRole_pkey" PRIMARY KEY ("panelId","role")
);

-- CreateTable
CREATE TABLE "NorthPanelAudienceGroup" (
    "organizationId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "NorthPanelAudienceGroup_pkey" PRIMARY KEY ("panelId","groupId")
);

-- CreateTable
CREATE TABLE "NorthPanelAudiencePermission" (
    "organizationId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,

    CONSTRAINT "NorthPanelAudiencePermission_pkey" PRIMARY KEY ("panelId","capability")
);

-- CreateTable
CREATE TABLE "NorthPanelAudienceMembership" (
    "organizationId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,

    CONSTRAINT "NorthPanelAudienceMembership_pkey" PRIMARY KEY ("panelId","membershipId")
);

-- CreateIndex
CREATE INDEX "NorthCategory_scope_status_order_id_idx" ON "NorthCategory"("scope", "status", "order", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NorthCategory_id_organizationId_key" ON "NorthCategory"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "NorthCategory_organizationId_slug_key" ON "NorthCategory"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "NorthSubcategory_organizationId_categoryId_status_order_id_idx" ON "NorthSubcategory"("organizationId", "categoryId", "status", "order", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NorthSubcategory_id_organizationId_key" ON "NorthSubcategory"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "NorthSubcategory_categoryId_slug_key" ON "NorthSubcategory"("categoryId", "slug");

-- CreateIndex
CREATE INDEX "NorthPanel_organizationId_subcategoryId_status_order_id_idx" ON "NorthPanel"("organizationId", "subcategoryId", "status", "order", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NorthPanel_id_organizationId_key" ON "NorthPanel"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "NorthPanel_subcategoryId_slug_key" ON "NorthPanel"("subcategoryId", "slug");

-- CreateIndex
CREATE INDEX "NorthCategorySlugAlias_categoryId_idx" ON "NorthCategorySlugAlias"("categoryId");

-- CreateIndex
CREATE INDEX "NorthSubcategorySlugAlias_subcategoryId_idx" ON "NorthSubcategorySlugAlias"("subcategoryId");

-- CreateIndex
CREATE INDEX "NorthPanelSlugAlias_panelId_idx" ON "NorthPanelSlugAlias"("panelId");

-- CreateIndex
CREATE INDEX "NorthRoleGrant_organizationId_role_capability_idx" ON "NorthRoleGrant"("organizationId", "role", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "NorthRoleGrant_organizationId_role_capability_scope_categor_key" ON "NorthRoleGrant"("organizationId", "role", "capability", "scope", "categoryId", "subcategoryId", "panelId");

-- CreateIndex
CREATE INDEX "NorthGroupGrant_organizationId_groupId_capability_idx" ON "NorthGroupGrant"("organizationId", "groupId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "NorthGroupGrant_organizationId_groupId_capability_scope_cat_key" ON "NorthGroupGrant"("organizationId", "groupId", "capability", "scope", "categoryId", "subcategoryId", "panelId");

-- CreateIndex
CREATE INDEX "NorthMembershipGrant_organizationId_membershipId_capability_idx" ON "NorthMembershipGrant"("organizationId", "membershipId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "NorthMembershipGrant_organizationId_membershipId_capability_key" ON "NorthMembershipGrant"("organizationId", "membershipId", "capability", "scope", "categoryId", "subcategoryId", "panelId");

-- CreateIndex
CREATE INDEX "NorthPanelAudienceRole_organizationId_idx" ON "NorthPanelAudienceRole"("organizationId");

-- CreateIndex
CREATE INDEX "NorthPanelAudienceGroup_organizationId_groupId_idx" ON "NorthPanelAudienceGroup"("organizationId", "groupId");

-- CreateIndex
CREATE INDEX "NorthPanelAudiencePermission_organizationId_idx" ON "NorthPanelAudiencePermission"("organizationId");

-- CreateIndex
CREATE INDEX "NorthPanelAudienceMembership_organizationId_membershipId_idx" ON "NorthPanelAudienceMembership"("organizationId", "membershipId");

-- AddForeignKey
ALTER TABLE "NorthCategory" ADD CONSTRAINT "NorthCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthSubcategory" ADD CONSTRAINT "NorthSubcategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthSubcategory" ADD CONSTRAINT "NorthSubcategory_categoryId_organizationId_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "NorthCategory"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanel" ADD CONSTRAINT "NorthPanel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanel" ADD CONSTRAINT "NorthPanel_subcategoryId_organizationId_fkey" FOREIGN KEY ("subcategoryId", "organizationId") REFERENCES "NorthSubcategory"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthCategorySlugAlias" ADD CONSTRAINT "NorthCategorySlugAlias_categoryId_organizationId_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "NorthCategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthSubcategorySlugAlias" ADD CONSTRAINT "NorthSubcategorySlugAlias_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "NorthSubcategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelSlugAlias" ADD CONSTRAINT "NorthPanelSlugAlias_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "NorthPanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPlatformGrant" ADD CONSTRAINT "NorthPlatformGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthRoleGrant" ADD CONSTRAINT "NorthRoleGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthRoleGrant" ADD CONSTRAINT "NorthRoleGrant_categoryId_organizationId_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "NorthCategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthRoleGrant" ADD CONSTRAINT "NorthRoleGrant_subcategoryId_organizationId_fkey" FOREIGN KEY ("subcategoryId", "organizationId") REFERENCES "NorthSubcategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthRoleGrant" ADD CONSTRAINT "NorthRoleGrant_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthGroupGrant" ADD CONSTRAINT "NorthGroupGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthGroupGrant" ADD CONSTRAINT "NorthGroupGrant_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthGroupGrant" ADD CONSTRAINT "NorthGroupGrant_categoryId_organizationId_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "NorthCategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthGroupGrant" ADD CONSTRAINT "NorthGroupGrant_subcategoryId_organizationId_fkey" FOREIGN KEY ("subcategoryId", "organizationId") REFERENCES "NorthSubcategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthGroupGrant" ADD CONSTRAINT "NorthGroupGrant_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthMembershipGrant" ADD CONSTRAINT "NorthMembershipGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthMembershipGrant" ADD CONSTRAINT "NorthMembershipGrant_membershipId_organizationId_fkey" FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthMembershipGrant" ADD CONSTRAINT "NorthMembershipGrant_categoryId_organizationId_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "NorthCategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthMembershipGrant" ADD CONSTRAINT "NorthMembershipGrant_subcategoryId_organizationId_fkey" FOREIGN KEY ("subcategoryId", "organizationId") REFERENCES "NorthSubcategory"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthMembershipGrant" ADD CONSTRAINT "NorthMembershipGrant_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelAudienceRole" ADD CONSTRAINT "NorthPanelAudienceRole_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelAudienceGroup" ADD CONSTRAINT "NorthPanelAudienceGroup_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelAudienceGroup" ADD CONSTRAINT "NorthPanelAudienceGroup_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelAudiencePermission" ADD CONSTRAINT "NorthPanelAudiencePermission_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelAudienceMembership" ADD CONSTRAINT "NorthPanelAudienceMembership_panelId_organizationId_fkey" FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NorthPanelAudienceMembership" ADD CONSTRAINT "NorthPanelAudienceMembership_membershipId_organizationId_fkey" FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Scope and resource invariants remain database-enforced even if an API client is bypassed.
ALTER TABLE "NorthCategory" ADD CONSTRAINT "NorthCategory_scope_owner_check" CHECK (
  ("scope" = 'ORGANIZATION' AND "organizationId" IS NOT NULL) OR
  ("scope" IN ('PLATFORM', 'PERSONAL') AND "organizationId" IS NULL)
);
ALTER TABLE "NorthCategory" ADD CONSTRAINT "NorthCategory_kind_class_check" CHECK (
  ("resourceKind" = 'SYSTEM' AND "categoryClass" = 'SYSTEM') OR
  ("resourceKind" = 'CONTENT' AND "categoryClass" IN ('TEMPLATE', 'CUSTOM'))
);
ALTER TABLE "NorthRoleGrant" ADD CONSTRAINT "NorthRoleGrant_scope_check" CHECK (
  ("scope" = 'ORGANIZATION' AND "categoryId" IS NULL AND "subcategoryId" IS NULL AND "panelId" IS NULL) OR
  ("scope" = 'CATEGORY' AND "categoryId" IS NOT NULL AND "subcategoryId" IS NULL AND "panelId" IS NULL) OR
  ("scope" = 'SUBCATEGORY' AND "categoryId" IS NULL AND "subcategoryId" IS NOT NULL AND "panelId" IS NULL) OR
  ("scope" = 'PANEL' AND "categoryId" IS NULL AND "subcategoryId" IS NULL AND "panelId" IS NOT NULL)
);
ALTER TABLE "NorthGroupGrant" ADD CONSTRAINT "NorthGroupGrant_scope_check" CHECK (
  ("scope" = 'ORGANIZATION' AND "categoryId" IS NULL AND "subcategoryId" IS NULL AND "panelId" IS NULL) OR
  ("scope" = 'CATEGORY' AND "categoryId" IS NOT NULL AND "subcategoryId" IS NULL AND "panelId" IS NULL) OR
  ("scope" = 'SUBCATEGORY' AND "categoryId" IS NULL AND "subcategoryId" IS NOT NULL AND "panelId" IS NULL) OR
  ("scope" = 'PANEL' AND "categoryId" IS NULL AND "subcategoryId" IS NULL AND "panelId" IS NOT NULL)
);
ALTER TABLE "NorthMembershipGrant" ADD CONSTRAINT "NorthMembershipGrant_scope_check" CHECK (
  ("scope" = 'ORGANIZATION' AND "categoryId" IS NULL AND "subcategoryId" IS NULL AND "panelId" IS NULL) OR
  ("scope" = 'CATEGORY' AND "categoryId" IS NOT NULL AND "subcategoryId" IS NULL AND "panelId" IS NULL) OR
  ("scope" = 'SUBCATEGORY' AND "categoryId" IS NULL AND "subcategoryId" IS NOT NULL AND "panelId" IS NULL) OR
  ("scope" = 'PANEL' AND "categoryId" IS NULL AND "subcategoryId" IS NULL AND "panelId" IS NOT NULL)
);

-- NULLs do not collide in a normal PostgreSQL UNIQUE constraint; these indexes
-- make organization-level grants genuinely idempotent.
CREATE UNIQUE INDEX "NorthRoleGrant_exact_scope_key" ON "NorthRoleGrant"
  ("organizationId", "role", "capability", "scope", COALESCE("categoryId", ''), COALESCE("subcategoryId", ''), COALESCE("panelId", ''));
CREATE UNIQUE INDEX "NorthGroupGrant_exact_scope_key" ON "NorthGroupGrant"
  ("organizationId", "groupId", "capability", "scope", COALESCE("categoryId", ''), COALESCE("subcategoryId", ''), COALESCE("panelId", ''));
CREATE UNIQUE INDEX "NorthMembershipGrant_exact_scope_key" ON "NorthMembershipGrant"
  ("organizationId", "membershipId", "capability", "scope", COALESCE("categoryId", ''), COALESCE("subcategoryId", ''), COALESCE("panelId", ''));

-- homePanelId may only reference a panel owned by the same organization.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_homePanelId_same_tenant_fkey"
  FOREIGN KEY ("homePanelId", "id") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Idempotent system bootstrap for organizations predating TASK 8. No demo or
-- editable customer content is introduced.
INSERT INTO "NorthCategory" ("id", "organizationId", "scope", "resourceKind", "categoryClass", "name", "slug", "order", "updatedAt")
SELECT 'northcat_home_' || md5(o."id"), o."id", 'ORGANIZATION', 'SYSTEM', 'SYSTEM', '{"es":"Home","en":"Home"}'::jsonb, 'home', 0, CURRENT_TIMESTAMP
FROM "Organization" o ON CONFLICT ("organizationId", "slug") DO NOTHING;
INSERT INTO "NorthCategory" ("id", "organizationId", "scope", "resourceKind", "categoryClass", "name", "slug", "order", "updatedAt")
SELECT 'northcat_admin_' || md5(o."id"), o."id", 'ORGANIZATION', 'SYSTEM', 'SYSTEM', '{"es":"Administración","en":"Administration"}'::jsonb, 'admin', 1000, CURRENT_TIMESTAMP
FROM "Organization" o ON CONFLICT ("organizationId", "slug") DO NOTHING;

INSERT INTO "NorthSubcategory" ("id", "organizationId", "categoryId", "resourceKind", "name", "slug", "order", "updatedAt")
SELECT 'northsub_home_' || md5(o."id"), o."id", c."id", 'SYSTEM', '{"es":"Resumen","en":"Overview"}'::jsonb, 'overview', 0, CURRENT_TIMESTAMP
FROM "Organization" o JOIN "NorthCategory" c ON c."organizationId" = o."id" AND c."slug" = 'home'
ON CONFLICT ("categoryId", "slug") DO NOTHING;
INSERT INTO "NorthSubcategory" ("id", "organizationId", "categoryId", "resourceKind", "name", "slug", "order", "updatedAt")
SELECT 'northsub_admin_' || md5(o."id"), o."id", c."id", 'SYSTEM', '{"es":"Configuración","en":"Settings"}'::jsonb, 'settings', 0, CURRENT_TIMESTAMP
FROM "Organization" o JOIN "NorthCategory" c ON c."organizationId" = o."id" AND c."slug" = 'admin'
ON CONFLICT ("categoryId", "slug") DO NOTHING;

INSERT INTO "NorthPanel" ("id", "organizationId", "subcategoryId", "resourceKind", "name", "slug", "order", "status", "updatedAt")
SELECT 'northpanel_home_' || md5(o."id"), o."id", s."id", 'SYSTEM', '{"es":"Home","en":"Home"}'::jsonb, 'home', 0, 'PUBLISHED', CURRENT_TIMESTAMP
FROM "Organization" o JOIN "NorthSubcategory" s ON s."organizationId" = o."id" AND s."slug" = 'overview'
ON CONFLICT ("subcategoryId", "slug") DO NOTHING;
INSERT INTO "NorthPanel" ("id", "organizationId", "subcategoryId", "resourceKind", "name", "slug", "order", "status", "audienceType", "updatedAt")
SELECT 'northpanel_admin_' || md5(o."id"), o."id", s."id", 'SYSTEM', '{"es":"Administración","en":"Administration"}'::jsonb, 'administration', 0, 'PUBLISHED', 'ROLES', CURRENT_TIMESTAMP
FROM "Organization" o JOIN "NorthSubcategory" s ON s."organizationId" = o."id" AND s."slug" = 'settings'
ON CONFLICT ("subcategoryId", "slug") DO NOTHING;

INSERT INTO "NorthPanelAudienceRole" ("organizationId", "panelId", "role")
SELECT p."organizationId", p."id", r.role::"TenantRole"
FROM "NorthPanel" p CROSS JOIN (VALUES ('OWNER'), ('ADMIN')) r(role)
WHERE p."resourceKind" = 'SYSTEM' AND p."slug" = 'administration'
ON CONFLICT DO NOTHING;
INSERT INTO "NorthRoleGrant" ("id", "organizationId", "role", "capability", "scope")
SELECT 'northgrant_' || md5(o."id" || ':' || r.role || ':' || c.capability), o."id", r.role::"TenantRole", c.capability, 'ORGANIZATION'
FROM "Organization" o
CROSS JOIN (VALUES ('MEMBER'), ('VIEWER'), ('BILLING_ADMIN')) r(role)
CROSS JOIN (VALUES ('north.category.read'), ('north.subcategory.read'), ('north.panel.read'), ('north.content.read')) c(capability)
ON CONFLICT DO NOTHING;

UPDATE "Organization" o SET "homePanelId" = p."id"
FROM "NorthPanel" p
WHERE o."homePanelId" IS NULL AND p."organizationId" = o."id" AND p."resourceKind" = 'SYSTEM' AND p."slug" = 'home';
