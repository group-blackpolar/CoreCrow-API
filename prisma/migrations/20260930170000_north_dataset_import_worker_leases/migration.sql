-- TD-02 worker leases: additive token fencing and a retryable fail-closed state.
ALTER TYPE "NorthDatasetImportStatus" ADD VALUE 'SECURITY_BLOCKED' AFTER 'SECURITY_PENDING';

ALTER TABLE "NorthDatasetImportJob"
  ADD COLUMN "claimToken" TEXT;

ALTER TABLE "NorthDatasetImportJob"
  DROP CONSTRAINT "NorthDatasetImportJob_claim_check";

ALTER TABLE "NorthDatasetImportJob"
  ADD CONSTRAINT "NorthDatasetImportJob_claim_check" CHECK (
    ("claimedAt" IS NULL AND "claimExpiresAt" IS NULL AND "claimedBy" IS NULL AND "claimToken" IS NULL) OR
    ("claimedAt" IS NOT NULL AND "claimExpiresAt" IS NOT NULL AND "claimedBy" IS NOT NULL AND "claimToken" IS NOT NULL AND "claimExpiresAt" > "claimedAt")
  );

CREATE UNIQUE INDEX "NorthDatasetImportJob_claimToken_key"
  ON "NorthDatasetImportJob"("claimToken") WHERE "claimToken" IS NOT NULL;
