CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "users"
  ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "users_status_createdAt_idx" ON "users"("status", "createdAt");
CREATE INDEX "Organization_status_createdAt_idx" ON "Organization"("status", "createdAt");
