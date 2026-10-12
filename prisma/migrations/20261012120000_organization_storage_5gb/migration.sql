-- Every organization gets 5 GiB of storage. Organizations still on the previous 10 GiB default are brought down to 5 GiB only when
-- they use less than that (nothing already stored is ever orphaned); custom limits set by operators are left alone.
ALTER TABLE "Organization" ALTER COLUMN "storageLimitBytes" SET DEFAULT 5368709120;
UPDATE "Organization"
SET "storageLimitBytes" = 5368709120
WHERE "storageLimitBytes" = 10737418240
  AND "storageUsedBytes" + "storageReservedBytes" <= 5368709120;
