ALTER TABLE "users"
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion" TEXT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_terms_consistency"
  CHECK (
    ("termsAcceptedAt" IS NULL AND "termsVersion" IS NULL)
    OR
    ("termsAcceptedAt" IS NOT NULL AND "termsVersion" IS NOT NULL)
  );
