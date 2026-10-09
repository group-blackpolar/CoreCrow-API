-- Pin READY assets and avatars to the exact object version that was inspected and scanned, so a later overwrite of the
-- same key (for example through a still-valid signed PUT) can never serve bytes that were not scanned.
-- Additive. No asset could reach READY before a scanner existed, so there is no legacy READY row to backfill; the
-- constraint nevertheless exempts rows that are not READY and deleted rows.
ALTER TABLE "NorthAsset" ADD COLUMN "storageVersionId" TEXT;
ALTER TABLE "UserAvatar" ADD COLUMN "storageVersionId" TEXT;

ALTER TABLE "NorthAsset" ADD CONSTRAINT "NorthAsset_ready_version_check" CHECK (
  "status" <> 'READY' OR "deletedAt" IS NOT NULL
  OR ("storageVersionId" IS NOT NULL AND char_length("storageVersionId") BETWEEN 1 AND 1024 AND "storageVersionId" <> 'null')
);
ALTER TABLE "UserAvatar" ADD CONSTRAINT "UserAvatar_ready_version_check" CHECK (
  "status" <> 'READY' OR "deletedAt" IS NOT NULL
  OR ("storageVersionId" IS NOT NULL AND char_length("storageVersionId") BETWEEN 1 AND 1024 AND "storageVersionId" <> 'null')
);
