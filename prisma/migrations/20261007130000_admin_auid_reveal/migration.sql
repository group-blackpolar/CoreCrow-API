-- Recoverable AUID for SUPERADMIN Reveal. Existing AUIDs stay hash-only until regenerated.
ALTER TABLE "users"
  ADD COLUMN "adminSecretCiphertext" TEXT,
  ADD COLUMN "adminSecretEncryptionVersion" INTEGER;
