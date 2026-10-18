-- Incremental imports: APPEND revision mode and the period covered by each import. Additive.
-- Rollback (only while no APPEND revision exists): ALTER TABLE "NorthDatasetImportJob" DROP COLUMN "activationMode", DROP COLUMN "periodStart", DROP COLUMN "periodEnd"; (enum values cannot be dropped in PostgreSQL; leaving APPEND is harmless).
ALTER TYPE "NorthDatasetRevisionMode" ADD VALUE 'APPEND';
ALTER TABLE "NorthDatasetImportJob" ADD COLUMN "activationMode" "NorthDatasetRevisionMode" NOT NULL DEFAULT 'REPLACE_DATASET', ADD COLUMN "periodStart" DATE, ADD COLUMN "periodEnd" DATE;
ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_period_check" CHECK ("periodEnd" IS NULL OR "periodStart" IS NULL OR "periodEnd" >= "periodStart");
CREATE INDEX "NorthDatasetImportJob_datasetId_status_periodStart_idx" ON "NorthDatasetImportJob"("datasetId", "status", "periodStart");
