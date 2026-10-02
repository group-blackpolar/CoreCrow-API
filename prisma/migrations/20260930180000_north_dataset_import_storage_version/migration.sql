ALTER TABLE "NorthDatasetImportJob"
  ADD COLUMN "storageVersionId" TEXT,
  ADD COLUMN "storageEtag" TEXT;

-- Previously confirmed jobs cannot be assigned a trustworthy provider version
-- after the fact. Preserve terminal history, finish pending cancellations, and
-- fail every other active legacy job closed before enforcing the invariant.
UPDATE "NorthDatasetImportJob"
SET
  "status" = 'CANCELLED',
  "progress" = 100,
  "cancelledAt" = COALESCE("cancelledAt", CURRENT_TIMESTAMP),
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "claimedAt" = NULL,
  "claimExpiresAt" = NULL,
  "claimedBy" = NULL,
  "claimToken" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "confirmedAt" IS NOT NULL
  AND "storageVersionId" IS NULL
  AND "status" = 'CANCEL_REQUESTED';

UPDATE "NorthDatasetImportJob"
SET
  "status" = 'FAILED',
  "progress" = 100,
  "lastErrorCode" = 'IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "claimedAt" = NULL,
  "claimExpiresAt" = NULL,
  "claimedBy" = NULL,
  "claimToken" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "confirmedAt" IS NOT NULL
  AND "storageVersionId" IS NULL
  AND "status" NOT IN ('SUCCEEDED', 'CANCELLED', 'REJECTED', 'FAILED');

ALTER TABLE "NorthDatasetImportJob"
  ADD CONSTRAINT "NorthDatasetImportJob_storage_version_check" CHECK (
    ("confirmedAt" IS NULL AND "storageVersionId" IS NULL)
    OR
    (
      "confirmedAt" IS NOT NULL
      AND "storageVersionId" IS NOT NULL
      AND char_length("storageVersionId") BETWEEN 1 AND 1024
      AND "storageVersionId" <> 'null'
    )
    OR
    (
      "storageVersionId" IS NULL
      AND "status" IN ('SUCCEEDED', 'CANCELLED', 'REJECTED', 'FAILED')
    )
  );
