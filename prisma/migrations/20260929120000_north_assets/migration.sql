-- TASK 8E: provider-neutral asset metadata and organization quota accounting.
-- Object bytes remain outside PostgreSQL.
CREATE TYPE "NorthAssetStatus" AS ENUM (
  'UPLOADING',
  'PROCESSING',
  'READY',
  'REJECTED',
  'QUARANTINED'
);

ALTER TABLE "Organization"
  ADD COLUMN "storageLimitBytes" BIGINT NOT NULL DEFAULT 10737418240,
  ADD COLUMN "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "storageReservedBytes" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_storage_quota_check"
  CHECK (
    "storageLimitBytes" >= 0 AND
    "storageUsedBytes" >= 0 AND
    "storageReservedBytes" >= 0 AND
    "storageUsedBytes" + "storageReservedBytes" <= "storageLimitBytes"
  );

CREATE TABLE "NorthAsset" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "checksum" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "status" "NorthAssetStatus" NOT NULL DEFAULT 'UPLOADING',
  "confirmedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NorthAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthAsset_size_check" CHECK ("size" > 0),
  CONSTRAINT "NorthAsset_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "NorthAsset_storageKey_key" ON "NorthAsset"("storageKey");
CREATE UNIQUE INDEX "NorthAsset_id_organizationId_key" ON "NorthAsset"("id", "organizationId");
CREATE INDEX "NorthAsset_organizationId_status_createdAt_idx" ON "NorthAsset"("organizationId", "status", "createdAt");
CREATE INDEX "NorthAsset_ownerId_createdAt_idx" ON "NorthAsset"("ownerId", "createdAt");

ALTER TABLE "NorthAsset" ADD CONSTRAINT "NorthAsset_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthAsset" ADD CONSTRAINT "NorthAsset_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
