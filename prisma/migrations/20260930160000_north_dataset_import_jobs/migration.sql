-- TD-02: durable, tenant-scoped XLSX import jobs. Parsing and activation remain disabled.
CREATE TYPE "NorthDatasetImportStatus" AS ENUM (
  'AWAITING_UPLOAD',
  'SECURITY_PENDING',
  'SECURITY_APPROVED',
  'ANALYZING',
  'AWAITING_MAPPING',
  'READY_TO_ACTIVATE',
  'ACTIVATING',
  'SUCCEEDED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'REJECTED',
  'FAILED'
);

CREATE TYPE "NorthDatasetImportScanStatus" AS ENUM (
  'PENDING', 'SCANNING', 'APPROVED', 'REJECTED', 'QUARANTINED', 'UNAVAILABLE'
);

CREATE TABLE "NorthDatasetImportJob" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "requestedMembershipId" TEXT NOT NULL,
  "idempotencyOperation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "declaredMime" TEXT NOT NULL,
  "declaredSize" BIGINT NOT NULL,
  "declaredChecksum" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "status" "NorthDatasetImportStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
  "scanStatus" "NorthDatasetImportScanStatus" NOT NULL DEFAULT 'PENDING',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "claimedBy" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "securityApprovedAt" TIMESTAMP(3),
  "cancellationRequestedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NorthDatasetImportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthDatasetImportJob_filename_check" CHECK (char_length("filename") BETWEEN 1 AND 255),
  CONSTRAINT "NorthDatasetImportJob_mime_check" CHECK ("declaredMime" = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  CONSTRAINT "NorthDatasetImportJob_size_check" CHECK ("declaredSize" > 0),
  CONSTRAINT "NorthDatasetImportJob_checksum_check" CHECK ("declaredChecksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "NorthDatasetImportJob_idempotency_operation_check" CHECK ("idempotencyOperation" = 'DATASET_IMPORT_PREPARE'),
  CONSTRAINT "NorthDatasetImportJob_idempotency_key_check" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{16,128}$'),
  CONSTRAINT "NorthDatasetImportJob_request_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "NorthDatasetImportJob_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
  CONSTRAINT "NorthDatasetImportJob_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 20),
  CONSTRAINT "NorthDatasetImportJob_claim_check" CHECK (
    ("claimedAt" IS NULL AND "claimExpiresAt" IS NULL AND "claimedBy" IS NULL) OR
    ("claimedAt" IS NOT NULL AND "claimExpiresAt" IS NOT NULL AND "claimedBy" IS NOT NULL AND "claimExpiresAt" > "claimedAt")
  ),
  CONSTRAINT "NorthDatasetImportJob_security_approval_check" CHECK (
    "securityApprovedAt" IS NULL OR "scanStatus" = 'APPROVED'
  )
);

CREATE UNIQUE INDEX "NorthDatasetImportJob_storageKey_key"
  ON "NorthDatasetImportJob"("storageKey");
CREATE UNIQUE INDEX "NorthDatasetImportJob_id_datasetId_org_key"
  ON "NorthDatasetImportJob"("id", "datasetId", "organizationId");
CREATE UNIQUE INDEX "NorthDatasetImportJob_idempotency_key"
  ON "NorthDatasetImportJob"("organizationId", "requestedMembershipId", "requestedBy", "idempotencyOperation", "idempotencyKey");
CREATE INDEX "NorthDatasetImportJob_org_dataset_created_idx"
  ON "NorthDatasetImportJob"("organizationId", "datasetId", "createdAt", "id");
CREATE INDEX "NorthDatasetImportJob_claimable_idx"
  ON "NorthDatasetImportJob"("status", "availableAt", "claimExpiresAt", "id");
CREATE INDEX "NorthDatasetImportJob_org_requester_created_idx"
  ON "NorthDatasetImportJob"("organizationId", "requestedBy", "createdAt", "id");

ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_datasetId_org_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_requestedBy_fkey"
  FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthDatasetImportJob" ADD CONSTRAINT "NorthDatasetImportJob_membership_org_fkey"
  FOREIGN KEY ("requestedMembershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
