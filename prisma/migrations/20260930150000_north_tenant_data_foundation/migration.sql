-- TD-01: tenant-scoped dataset metadata, immutable schema snapshots, and dataset ACLs.
-- Data rows, query execution, bindings, and import jobs are deliberately deferred.
CREATE TYPE "NorthPanelAccessPolicyMode" AS ENUM ('LEGACY_AUDIENCE', 'ACL_V1');
CREATE TYPE "NorthDatasetStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "NorthDatasetFieldType" AS ENUM (
  'TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'TIME'
);
CREATE TYPE "NorthDatasetFieldStatus" AS ENUM ('ACTIVE', 'DEPRECATED');
CREATE TYPE "NorthDatasetAclEffect" AS ENUM ('ALLOW', 'DENY');
CREATE TYPE "NorthDatasetAclPrincipalType" AS ENUM (
  'ALL_MEMBERS', 'MEMBERSHIP', 'GROUP', 'ROLE', 'CAPABILITY'
);

ALTER TABLE "NorthPanel"
  ADD COLUMN "accessPolicyMode" "NorthPanelAccessPolicyMode" NOT NULL DEFAULT 'LEGACY_AUDIENCE';

CREATE TABLE "NorthDataset" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" JSONB NOT NULL,
  "description" JSONB,
  "slug" TEXT NOT NULL,
  "status" "NorthDatasetStatus" NOT NULL DEFAULT 'ACTIVE',
  "currentSchemaVersionId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NorthDataset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDataset_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{0,62}[a-z0-9]$' OR "slug" ~ '^[a-z]$')
);

CREATE TABLE "NorthDatasetField" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "displayName" JSONB NOT NULL,
  "description" JSONB,
  "canonicalType" "NorthDatasetFieldType" NOT NULL,
  "semanticType" TEXT,
  "nullable" BOOLEAN NOT NULL DEFAULT true,
  "status" "NorthDatasetFieldStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NorthDatasetField_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetField_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "NorthDatasetField_semanticType_check" CHECK (
    "semanticType" IS NULL OR "semanticType" ~ '^[a-z][a-z0-9_]{0,63}$'
  )
);

CREATE TABLE "NorthDatasetSchemaVersion" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetSchemaVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetSchemaVersion_version_check" CHECK ("version" > 0)
);

CREATE TABLE "NorthDatasetSchemaVersionField" (
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "schemaVersionId" TEXT NOT NULL,
  "datasetFieldId" TEXT NOT NULL,
  "canonicalType" "NorthDatasetFieldType" NOT NULL,
  "semanticType" TEXT,
  "nullable" BOOLEAN NOT NULL,
  "status" "NorthDatasetFieldStatus" NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "NorthDatasetSchemaVersionField_pkey" PRIMARY KEY ("schemaVersionId", "datasetFieldId"),
  CONSTRAINT "NorthDatasetSchemaVersionField_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "NorthDatasetSchemaVersionField_semanticType_check" CHECK (
    "semanticType" IS NULL OR "semanticType" ~ '^[a-z][a-z0-9_]{0,63}$'
  )
);

CREATE TABLE "NorthDatasetAcl" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "effect" "NorthDatasetAclEffect" NOT NULL,
  "principalType" "NorthDatasetAclPrincipalType" NOT NULL,
  "membershipId" TEXT,
  "groupId" TEXT,
  "role" "TenantRole",
  "capability" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetAcl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetAcl_principal_check" CHECK (
    ("principalType" = 'ALL_MEMBERS' AND "membershipId" IS NULL AND "groupId" IS NULL AND "role" IS NULL AND "capability" IS NULL) OR
    ("principalType" = 'MEMBERSHIP' AND "membershipId" IS NOT NULL AND "groupId" IS NULL AND "role" IS NULL AND "capability" IS NULL) OR
    ("principalType" = 'GROUP' AND "membershipId" IS NULL AND "groupId" IS NOT NULL AND "role" IS NULL AND "capability" IS NULL) OR
    ("principalType" = 'ROLE' AND "membershipId" IS NULL AND "groupId" IS NULL AND "role" IS NOT NULL AND "capability" IS NULL) OR
    ("principalType" = 'CAPABILITY' AND "membershipId" IS NULL AND "groupId" IS NULL AND "role" IS NULL AND "capability" IS NOT NULL)
  ),
  CONSTRAINT "NorthDatasetAcl_capability_check" CHECK (
    "capability" IS NULL OR "capability" ~ '^north\.[a-z][a-z0-9_.-]{0,119}$'
  )
);

CREATE UNIQUE INDEX "NorthDataset_id_organizationId_key"
  ON "NorthDataset"("id", "organizationId");
CREATE UNIQUE INDEX "NorthDataset_organizationId_slug_key"
  ON "NorthDataset"("organizationId", "slug");
CREATE INDEX "NorthDataset_organizationId_status_createdAt_id_idx"
  ON "NorthDataset"("organizationId", "status", "createdAt", "id");

CREATE UNIQUE INDEX "NorthDatasetField_id_datasetId_organizationId_key"
  ON "NorthDatasetField"("id", "datasetId", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetField_datasetId_key_key"
  ON "NorthDatasetField"("datasetId", "key");
CREATE INDEX "NorthDatasetField_organizationId_datasetId_status_id_idx"
  ON "NorthDatasetField"("organizationId", "datasetId", "status", "id");

CREATE UNIQUE INDEX "NorthDatasetSchemaVersion_id_datasetId_org_key"
  ON "NorthDatasetSchemaVersion"("id", "datasetId", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetSchemaVersion_datasetId_version_key"
  ON "NorthDatasetSchemaVersion"("datasetId", "version");
CREATE INDEX "NorthDatasetSchemaVersion_org_dataset_created_idx"
  ON "NorthDatasetSchemaVersion"("organizationId", "datasetId", "createdAt");

CREATE UNIQUE INDEX "NorthDatasetSchemaVersionField_schema_ordinal_key"
  ON "NorthDatasetSchemaVersionField"("schemaVersionId", "ordinal");
CREATE INDEX "NorthDatasetSchemaVersionField_org_dataset_schema_idx"
  ON "NorthDatasetSchemaVersionField"("organizationId", "datasetId", "schemaVersionId");

CREATE UNIQUE INDEX "NorthDatasetAcl_id_datasetId_organizationId_key"
  ON "NorthDatasetAcl"("id", "datasetId", "organizationId");
CREATE INDEX "NorthDatasetAcl_org_dataset_effect_principal_idx"
  ON "NorthDatasetAcl"("organizationId", "datasetId", "effect", "principalType");
CREATE INDEX "NorthDatasetAcl_organizationId_membershipId_idx"
  ON "NorthDatasetAcl"("organizationId", "membershipId");
CREATE INDEX "NorthDatasetAcl_organizationId_groupId_idx"
  ON "NorthDatasetAcl"("organizationId", "groupId");
CREATE UNIQUE INDEX "NorthDatasetAcl_all_members_unique"
  ON "NorthDatasetAcl"("datasetId", "effect") WHERE "principalType" = 'ALL_MEMBERS';
CREATE UNIQUE INDEX "NorthDatasetAcl_membership_unique"
  ON "NorthDatasetAcl"("datasetId", "effect", "membershipId") WHERE "principalType" = 'MEMBERSHIP';
CREATE UNIQUE INDEX "NorthDatasetAcl_group_unique"
  ON "NorthDatasetAcl"("datasetId", "effect", "groupId") WHERE "principalType" = 'GROUP';
CREATE UNIQUE INDEX "NorthDatasetAcl_role_unique"
  ON "NorthDatasetAcl"("datasetId", "effect", "role") WHERE "principalType" = 'ROLE';
CREATE UNIQUE INDEX "NorthDatasetAcl_capability_unique"
  ON "NorthDatasetAcl"("datasetId", "effect", "capability") WHERE "principalType" = 'CAPABILITY';

ALTER TABLE "NorthDataset" ADD CONSTRAINT "NorthDataset_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDataset" ADD CONSTRAINT "NorthDataset_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthDatasetField" ADD CONSTRAINT "NorthDatasetField_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetField" ADD CONSTRAINT "NorthDatasetField_datasetId_org_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthDatasetSchemaVersion" ADD CONSTRAINT "NorthDatasetSchemaVersion_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetSchemaVersion" ADD CONSTRAINT "NorthDatasetSchemaVersion_datasetId_org_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetSchemaVersion" ADD CONSTRAINT "NorthDatasetSchemaVersion_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthDatasetSchemaVersionField" ADD CONSTRAINT "NorthDatasetSchemaVersionField_schema_fkey"
  FOREIGN KEY ("schemaVersionId", "datasetId", "organizationId")
  REFERENCES "NorthDatasetSchemaVersion"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetSchemaVersionField" ADD CONSTRAINT "NorthDatasetSchemaVersionField_field_fkey"
  FOREIGN KEY ("datasetFieldId", "datasetId", "organizationId")
  REFERENCES "NorthDatasetField"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthDatasetAcl" ADD CONSTRAINT "NorthDatasetAcl_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetAcl" ADD CONSTRAINT "NorthDatasetAcl_datasetId_org_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetAcl" ADD CONSTRAINT "NorthDatasetAcl_membershipId_org_fkey"
  FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetAcl" ADD CONSTRAINT "NorthDatasetAcl_groupId_org_fkey"
  FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetAcl" ADD CONSTRAINT "NorthDatasetAcl_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthDataset" ADD CONSTRAINT "NorthDataset_currentSchemaVersion_fkey"
  FOREIGN KEY ("currentSchemaVersionId", "id", "organizationId")
  REFERENCES "NorthDatasetSchemaVersion"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_north_dataset_schema_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'North dataset schema snapshots are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NorthDatasetSchemaVersion_reject_update_delete"
BEFORE UPDATE OR DELETE ON "NorthDatasetSchemaVersion"
FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetSchemaVersion_reject_truncate"
BEFORE TRUNCATE ON "NorthDatasetSchemaVersion"
FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetSchemaVersionField_reject_update_delete"
BEFORE UPDATE OR DELETE ON "NorthDatasetSchemaVersionField"
FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetSchemaVersionField_reject_truncate"
BEFORE TRUNCATE ON "NorthDatasetSchemaVersionField"
FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
