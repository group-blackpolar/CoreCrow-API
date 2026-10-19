-- Pipeline scripts (versioned, immutable) + run history, and resumable multipart uploads. Additive.
-- Rollback: DROP TABLE "NorthPipelineRun"; DROP TABLE "NorthPipelineScriptVersion"; DROP TABLE "NorthPipelineScript"; DROP TYPE "NorthPipelineRunStatus"; DROP TYPE "NorthPipelineRunKind";
--   ALTER TABLE "NorthDatasetGroup" DROP COLUMN "activeScriptVersionId"; ALTER TABLE "NorthDatasetImportJob" DROP COLUMN "multipartUploadId", DROP COLUMN "multipartPartSize";
CREATE TYPE "NorthPipelineRunKind" AS ENUM ('TEST', 'REPROCESS', 'IMPORT');
CREATE TYPE "NorthPipelineRunStatus" AS ENUM ('QUEUED', 'BLOCKED', 'RUNNING', 'SUCCEEDED', 'FAILED');
ALTER TABLE "NorthDatasetGroup" ADD COLUMN "activeScriptVersionId" TEXT;
ALTER TABLE "NorthDatasetImportJob" ADD COLUMN "multipartUploadId" TEXT, ADD COLUMN "multipartPartSize" INTEGER;

CREATE TABLE "NorthPipelineScript" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "groupId" TEXT NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL,
  "description" TEXT, "language" TEXT NOT NULL DEFAULT 'python', "status" "NorthDatasetGroupStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NorthPipelineScript_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NorthPipelineScript_id_organizationId_key" ON "NorthPipelineScript"("id", "organizationId");
CREATE UNIQUE INDEX "NorthPipelineScript_groupId_slug_key" ON "NorthPipelineScript"("groupId", "slug");
CREATE INDEX "NorthPipelineScript_organizationId_groupId_status_idx" ON "NorthPipelineScript"("organizationId", "groupId", "status");
ALTER TABLE "NorthPipelineScript" ADD CONSTRAINT "NorthPipelineScript_group_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "NorthDatasetGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "NorthPipelineScriptVersion" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "scriptId" TEXT NOT NULL, "version" INTEGER NOT NULL, "source" TEXT NOT NULL,
  "sourceSha256" TEXT NOT NULL, "params" JSONB NOT NULL DEFAULT '[]', "steps" JSONB NOT NULL DEFAULT '[]', "note" TEXT,
  "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NorthPipelineScriptVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthPipelineScriptVersion_source_size" CHECK (octet_length("source") <= 262144)
);
CREATE UNIQUE INDEX "NorthPipelineScriptVersion_scriptId_version_key" ON "NorthPipelineScriptVersion"("scriptId", "version");
CREATE UNIQUE INDEX "NorthPipelineScriptVersion_id_organizationId_key" ON "NorthPipelineScriptVersion"("id", "organizationId");
ALTER TABLE "NorthPipelineScriptVersion" ADD CONSTRAINT "NorthPipelineScriptVersion_script_fkey" FOREIGN KEY ("scriptId", "organizationId") REFERENCES "NorthPipelineScript"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A published script version is evidence of what processed a dataset: it can never change or disappear.
CREATE OR REPLACE FUNCTION reject_north_pipeline_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'North pipeline script versions are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "NorthPipelineScriptVersion_reject_update_delete" BEFORE UPDATE OR DELETE ON "NorthPipelineScriptVersion" FOR EACH ROW EXECUTE FUNCTION reject_north_pipeline_version_mutation();
CREATE TRIGGER "NorthPipelineScriptVersion_reject_truncate" BEFORE TRUNCATE ON "NorthPipelineScriptVersion" FOR EACH STATEMENT EXECUTE FUNCTION reject_north_pipeline_version_mutation();

CREATE TABLE "NorthPipelineRun" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "groupId" TEXT NOT NULL, "datasetId" TEXT, "importId" TEXT, "scriptVersionId" TEXT NOT NULL,
  "kind" "NorthPipelineRunKind" NOT NULL, "status" "NorthPipelineRunStatus" NOT NULL DEFAULT 'QUEUED', "params" JSONB NOT NULL DEFAULT '{}',
  "stats" JSONB, "report" JSONB, "errorCode" TEXT, "requestedBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  CONSTRAINT "NorthPipelineRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NorthPipelineRun_organizationId_groupId_createdAt_idx" ON "NorthPipelineRun"("organizationId", "groupId", "createdAt");
CREATE INDEX "NorthPipelineRun_organizationId_datasetId_createdAt_idx" ON "NorthPipelineRun"("organizationId", "datasetId", "createdAt");
ALTER TABLE "NorthPipelineRun" ADD CONSTRAINT "NorthPipelineRun_group_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "NorthDatasetGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthPipelineRun" ADD CONSTRAINT "NorthPipelineRun_version_fkey" FOREIGN KEY ("scriptVersionId", "organizationId") REFERENCES "NorthPipelineScriptVersion"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
