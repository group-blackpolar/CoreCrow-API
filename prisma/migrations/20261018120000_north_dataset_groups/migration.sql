-- Dataset Groups: logical collections of datasets with a covered period. Additive; existing datasets keep groupId NULL.
-- Rollback: ALTER TABLE "NorthDataset" DROP COLUMN "groupId", DROP COLUMN "periodStart", DROP COLUMN "periodEnd", DROP COLUMN "periodLabel"; DROP TABLE "NorthDatasetGroup"; DROP TYPE "NorthDatasetGroupStatus";
CREATE TYPE "NorthDatasetGroupStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TABLE "NorthDatasetGroup" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" JSONB NOT NULL,
  "description" JSONB,
  "category" TEXT,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "status" "NorthDatasetGroupStatus" NOT NULL DEFAULT 'ACTIVE',
  "ownerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NorthDatasetGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NorthDatasetGroup_id_organizationId_key" ON "NorthDatasetGroup"("id", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetGroup_organizationId_slug_key" ON "NorthDatasetGroup"("organizationId", "slug");
CREATE INDEX "NorthDatasetGroup_organizationId_status_createdAt_id_idx" ON "NorthDatasetGroup"("organizationId", "status", "createdAt", "id");
ALTER TABLE "NorthDatasetGroup" ADD CONSTRAINT "NorthDatasetGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetGroup" ADD CONSTRAINT "NorthDatasetGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDataset" ADD COLUMN "groupId" TEXT, ADD COLUMN "periodStart" DATE, ADD COLUMN "periodEnd" DATE, ADD COLUMN "periodLabel" TEXT;
ALTER TABLE "NorthDataset" ADD CONSTRAINT "NorthDataset_period_check" CHECK ("periodEnd" IS NULL OR "periodStart" IS NULL OR "periodEnd" >= "periodStart");
ALTER TABLE "NorthDataset" ADD CONSTRAINT "NorthDataset_group_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "NorthDatasetGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "NorthDataset_organizationId_groupId_periodStart_idx" ON "NorthDataset"("organizationId", "groupId", "periodStart");
