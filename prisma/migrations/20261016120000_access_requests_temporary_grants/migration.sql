-- Temporary direct permission grants and access requests. Additive.
-- Rollback: DROP TABLE "AccessRequest"; DROP TYPE "AccessRequestStatus"; ALTER TABLE "MembershipPermissionGrant" DROP COLUMN "expiresAt", DROP COLUMN "grantedBy";
ALTER TABLE "MembershipPermissionGrant" ADD COLUMN "expiresAt" TIMESTAMP(3), ADD COLUMN "grantedBy" TEXT;
CREATE INDEX "MembershipPermissionGrant_expiresAt_idx" ON "MembershipPermissionGrant"("expiresAt");
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');
CREATE TABLE "AccessRequest" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requestedDays" INTEGER,
  "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "grantExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccessRequest_requestedDays_check" CHECK ("requestedDays" IS NULL OR ("requestedDays" >= 1 AND "requestedDays" <= 365))
);
CREATE INDEX "AccessRequest_organizationId_status_createdAt_idx" ON "AccessRequest"("organizationId", "status", "createdAt");
CREATE INDEX "AccessRequest_membershipId_status_idx" ON "AccessRequest"("membershipId", "status");
-- One open request per member and permission, enforced by the database (races included).
CREATE UNIQUE INDEX "AccessRequest_one_pending_idx" ON "AccessRequest"("membershipId", "permission") WHERE "status" = 'PENDING';
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_membershipId_organizationId_fkey" FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
