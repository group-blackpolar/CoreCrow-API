-- The legacy identifier column is retained, but scrubbed, for one rollback
-- window because the previous application image still selects it. No current
-- code reads or writes it. A later migration may drop the empty column/index
-- after the rollback image is retired.
ALTER TABLE "users"
  ADD COLUMN "adminSecretHash" TEXT,
  ADD COLUMN "passwordChangeRequired" BOOLEAN NOT NULL DEFAULT false;

UPDATE "users" SET "adminUniqueId" = NULL
WHERE "adminUniqueId" IS NOT NULL;
