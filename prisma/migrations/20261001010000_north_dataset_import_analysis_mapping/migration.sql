-- TD-02: approved XLSX analysis and immutable mapping versions. No rows or manifests yet.
ALTER TYPE "NorthDatasetImportStatus" ADD VALUE IF NOT EXISTS 'ANALYSIS_BLOCKED';

CREATE TABLE "NorthDatasetImportAnalysis" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "workbook" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetImportAnalysis_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetImportAnalysis_parserVersion_check" CHECK (char_length("parserVersion") BETWEEN 1 AND 128)
);

CREATE TABLE "NorthDatasetImportMappingVersion" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "sheetOrdinal" INTEGER NOT NULL,
  "headerRow" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthDatasetImportMappingVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetImportMappingVersion_version_check" CHECK ("version" > 0),
  CONSTRAINT "NorthDatasetImportMappingVersion_sheetOrdinal_check" CHECK ("sheetOrdinal" >= 0),
  CONSTRAINT "NorthDatasetImportMappingVersion_headerRow_check" CHECK ("headerRow" >= 1)
);

CREATE UNIQUE INDEX "NorthDatasetImportAnalysis_importId_key" ON "NorthDatasetImportAnalysis"("importId");
CREATE UNIQUE INDEX "NorthDatasetImportAnalysis_id_importId_datasetId_org_key"
  ON "NorthDatasetImportAnalysis"("id", "importId", "datasetId", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetImportAnalysis_importId_datasetId_org_key"
  ON "NorthDatasetImportAnalysis"("importId", "datasetId", "organizationId");
CREATE INDEX "NorthDatasetImportAnalysis_org_dataset_created_idx"
  ON "NorthDatasetImportAnalysis"("organizationId", "datasetId", "createdAt");

CREATE UNIQUE INDEX "NorthDatasetImportMappingVersion_importId_version_key"
  ON "NorthDatasetImportMappingVersion"("importId", "version");
CREATE UNIQUE INDEX "NorthDatasetImportMappingVersion_id_import_dataset_org_key"
  ON "NorthDatasetImportMappingVersion"("id", "importId", "datasetId", "organizationId");
CREATE INDEX "NorthDatasetImportMappingVersion_org_dataset_import_created_idx"
  ON "NorthDatasetImportMappingVersion"("organizationId", "datasetId", "importId", "createdAt");

ALTER TABLE "NorthDatasetImportAnalysis" ADD CONSTRAINT "NorthDatasetImportAnalysis_organization_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportAnalysis" ADD CONSTRAINT "NorthDatasetImportAnalysis_dataset_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportAnalysis" ADD CONSTRAINT "NorthDatasetImportAnalysis_import_fkey"
  FOREIGN KEY ("importId", "datasetId", "organizationId") REFERENCES "NorthDatasetImportJob"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthDatasetImportMappingVersion" ADD CONSTRAINT "NorthDatasetImportMappingVersion_organization_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportMappingVersion" ADD CONSTRAINT "NorthDatasetImportMappingVersion_dataset_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportMappingVersion" ADD CONSTRAINT "NorthDatasetImportMappingVersion_import_fkey"
  FOREIGN KEY ("importId", "datasetId", "organizationId") REFERENCES "NorthDatasetImportJob"("id", "datasetId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportMappingVersion" ADD CONSTRAINT "NorthDatasetImportMappingVersion_creator_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "NorthDatasetImportAnalysis_reject_update_delete"
BEFORE UPDATE OR DELETE ON "NorthDatasetImportAnalysis"
FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetImportAnalysis_reject_truncate"
BEFORE TRUNCATE ON "NorthDatasetImportAnalysis"
FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetImportMappingVersion_reject_update_delete"
BEFORE UPDATE OR DELETE ON "NorthDatasetImportMappingVersion"
FOR EACH ROW EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
CREATE TRIGGER "NorthDatasetImportMappingVersion_reject_truncate"
BEFORE TRUNCATE ON "NorthDatasetImportMappingVersion"
FOR EACH STATEMENT EXECUTE FUNCTION reject_north_dataset_schema_snapshot_mutation();
