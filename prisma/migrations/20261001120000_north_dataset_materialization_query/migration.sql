-- TD-02/03 minimal REPLACE_DATASET materialization, immutable manifests and active revision query support.
CREATE TYPE "NorthDatasetRevisionMode" AS ENUM ('REPLACE_DATASET');

ALTER TABLE "NorthDataset" ADD COLUMN "activeRevisionId" TEXT;
ALTER TABLE "NorthDatasetImportJob"
  ADD COLUMN "activationMappingId" TEXT,
  ADD COLUMN "activationRequestedBy" TEXT,
  ADD COLUMN "materializationAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "NorthDatasetImportBatch" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "schemaVersionId" TEXT NOT NULL,
  "mappingVersionId" TEXT NOT NULL,
  "sheetOrdinal" INTEGER NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetImportBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetImportBatch_rowCount_check" CHECK ("rowCount" >= 0 AND "rowCount" <= 50000),
  CONSTRAINT "NorthDatasetImportBatch_sheetOrdinal_check" CHECK ("sheetOrdinal" >= 0 AND "sheetOrdinal" < 32)
);

CREATE TABLE "NorthDatasetRow" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "values" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetRow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetRow_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "NorthDatasetRow_values_check" CHECK (jsonb_typeof("values") = 'object')
);

CREATE TABLE "NorthDatasetRevision" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "schemaVersionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "mode" "NorthDatasetRevisionMode" NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetRevision_version_check" CHECK ("version" > 0),
  CONSTRAINT "NorthDatasetRevision_rowCount_check" CHECK ("rowCount" >= 0)
);

CREATE TABLE "NorthDatasetRevisionBatch" (
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "NorthDatasetRevisionBatch_pkey" PRIMARY KEY ("revisionId", "batchId"),
  CONSTRAINT "NorthDatasetRevisionBatch_ordinal_check" CHECK ("ordinal" >= 0)
);

CREATE UNIQUE INDEX "NorthDatasetImportBatch_importId_key" ON "NorthDatasetImportBatch"("importId");
CREATE UNIQUE INDEX "NorthDatasetImportBatch_id_dataset_org_key" ON "NorthDatasetImportBatch"("id", "datasetId", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetImportBatch_import_dataset_org_key" ON "NorthDatasetImportBatch"("importId", "datasetId", "organizationId");
CREATE INDEX "NorthDatasetImportBatch_org_dataset_created_idx" ON "NorthDatasetImportBatch"("organizationId", "datasetId", "createdAt");
CREATE INDEX "NorthDatasetImportBatch_schema_idx" ON "NorthDatasetImportBatch"("schemaVersionId");
CREATE UNIQUE INDEX "NorthDatasetRow_batch_ordinal_key" ON "NorthDatasetRow"("batchId", "ordinal");
CREATE INDEX "NorthDatasetRow_org_dataset_batch_ordinal_idx" ON "NorthDatasetRow"("organizationId", "datasetId", "batchId", "ordinal");
CREATE UNIQUE INDEX "NorthDatasetRevision_id_dataset_org_key" ON "NorthDatasetRevision"("id", "datasetId", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetRevision_dataset_version_key" ON "NorthDatasetRevision"("datasetId", "version");
CREATE INDEX "NorthDatasetRevision_org_dataset_created_idx" ON "NorthDatasetRevision"("organizationId", "datasetId", "createdAt");
CREATE UNIQUE INDEX "NorthDatasetRevisionBatch_revision_ordinal_key" ON "NorthDatasetRevisionBatch"("revisionId", "ordinal");
CREATE INDEX "NorthDatasetRevisionBatch_batch_idx" ON "NorthDatasetRevisionBatch"("batchId");
CREATE INDEX "NorthDatasetRevisionBatch_org_dataset_revision_idx" ON "NorthDatasetRevisionBatch"("organizationId", "datasetId", "revisionId");

ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_activationMapping_fkey"
  FOREIGN KEY ("activationMappingId", "id", "datasetId", "organizationId") REFERENCES "NorthDatasetImportMappingVersion"("id", "importId", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_activationRequester_fkey"
  FOREIGN KEY ("activationRequestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_dataset_fkey" FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_import_fkey" FOREIGN KEY ("importId", "datasetId", "organizationId") REFERENCES "NorthDatasetImportJob"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_mapping_fkey" FOREIGN KEY ("mappingVersionId", "importId", "datasetId", "organizationId") REFERENCES "NorthDatasetImportMappingVersion"("id", "importId", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_schema_fkey" FOREIGN KEY ("schemaVersionId", "datasetId", "organizationId") REFERENCES "NorthDatasetSchemaVersion"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRow" ADD CONSTRAINT "NorthDatasetRow_batch_fkey" FOREIGN KEY ("batchId", "datasetId", "organizationId") REFERENCES "NorthDatasetImportBatch"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRevision" ADD CONSTRAINT "NorthDatasetRevision_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRevision" ADD CONSTRAINT "NorthDatasetRevision_dataset_fkey" FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRevision" ADD CONSTRAINT "NorthDatasetRevision_schema_fkey" FOREIGN KEY ("schemaVersionId", "datasetId", "organizationId") REFERENCES "NorthDatasetSchemaVersion"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRevision" ADD CONSTRAINT "NorthDatasetRevision_creator_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRevisionBatch" ADD CONSTRAINT "NorthDatasetRevisionBatch_revision_fkey" FOREIGN KEY ("revisionId", "datasetId", "organizationId") REFERENCES "NorthDatasetRevision"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetRevisionBatch" ADD CONSTRAINT "NorthDatasetRevisionBatch_batch_fkey" FOREIGN KEY ("batchId", "datasetId", "organizationId") REFERENCES "NorthDatasetImportBatch"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDataset" ADD CONSTRAINT "NorthDataset_activeRevision_fkey" FOREIGN KEY ("activeRevisionId", "id", "organizationId") REFERENCES "NorthDatasetRevision"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "NorthDatasetImportBatch_reject_update_delete" BEFORE UPDATE OR DELETE ON "NorthDatasetImportBatch" FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetImportBatch_reject_truncate" BEFORE TRUNCATE ON "NorthDatasetImportBatch" FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetRow_reject_update_delete" BEFORE UPDATE OR DELETE ON "NorthDatasetRow" FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetRow_reject_truncate" BEFORE TRUNCATE ON "NorthDatasetRow" FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetRevision_reject_update_delete" BEFORE UPDATE OR DELETE ON "NorthDatasetRevision" FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetRevision_reject_truncate" BEFORE TRUNCATE ON "NorthDatasetRevision" FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetRevisionBatch_reject_update_delete" BEFORE UPDATE OR DELETE ON "NorthDatasetRevisionBatch" FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetRevisionBatch_reject_truncate" BEFORE TRUNCATE ON "NorthDatasetRevisionBatch" FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
