-- Security & access: per-organization policy, devices, IP rules, alerts and retention log. Additive; sessions gain two nullable columns.
-- Rollback: DROP the five tables and four enums; ALTER TABLE "sessions" DROP COLUMN "deviceId", DROP COLUMN "securityOrganizationId".
CREATE TYPE "SecurityOverflowPolicy" AS ENUM ('BLOCK_NEW', 'REPLACE_OLDEST', 'REQUIRE_USER_CHOICE');
CREATE TYPE "SecurityIpRuleKind" AS ENUM ('ALLOW', 'DENY');
CREATE TYPE "SecurityAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE "SecurityAlertEmailStatus" AS ENUM ('NONE', 'SENT', 'FAILED');
ALTER TABLE "sessions" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "securityOrganizationId" TEXT;
CREATE TABLE "organization_security_policies" (
    "organizationId" TEXT NOT NULL,
    "enforcement" BOOLEAN NOT NULL DEFAULT false,
    "maxDevices" INTEGER,
    "maxSessions" INTEGER,
    "overflowPolicy" "SecurityOverflowPolicy" NOT NULL DEFAULT 'BLOCK_NEW',
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertEmailRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "retentionExemptUntil" TIMESTAMP(3),
    "retentionExemptReason" TEXT,
    "retentionExemptBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "organization_security_policies_pkey" PRIMARY KEY ("organizationId")
);
CREATE TABLE "security_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "firstIp" TEXT,
    "lastIp" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "security_devices_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "security_ip_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "SecurityIpRuleKind" NOT NULL,
    "cidr" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_ip_rules_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "security_alerts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "userId" TEXT,
    "dedupKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "details" JSONB,
    "status" "SecurityAlertStatus" NOT NULL DEFAULT 'OPEN',
    "emailStatus" "SecurityAlertEmailStatus" NOT NULL DEFAULT 'NONE',
    "emailError" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledBy" TEXT,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "security_retention_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retentionDays" INTEGER NOT NULL,
    "purgedAlerts" INTEGER NOT NULL DEFAULT 0,
    "purgedDevices" INTEGER NOT NULL DEFAULT 0,
    "skipped" TEXT,

    CONSTRAINT "security_retention_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "security_devices_tokenHash_key" ON "security_devices"("tokenHash");
CREATE INDEX "security_devices_organizationId_revokedAt_lastSeenAt_idx" ON "security_devices"("organizationId", "revokedAt", "lastSeenAt");
CREATE INDEX "security_devices_userId_revokedAt_idx" ON "security_devices"("userId", "revokedAt");
CREATE UNIQUE INDEX "security_ip_rules_organizationId_kind_cidr_key" ON "security_ip_rules"("organizationId", "kind", "cidr");
CREATE INDEX "security_alerts_organizationId_status_lastSeenAt_idx" ON "security_alerts"("organizationId", "status", "lastSeenAt");
CREATE UNIQUE INDEX "security_alerts_organizationId_dedupKey_key" ON "security_alerts"("organizationId", "dedupKey");
CREATE INDEX "security_retention_runs_organizationId_ranAt_idx" ON "security_retention_runs"("organizationId", "ranAt");
CREATE INDEX "sessions_securityOrganizationId_createdAt_idx" ON "sessions"("securityOrganizationId", "createdAt");
CREATE INDEX "sessions_userId_createdAt_idx" ON "sessions"("userId", "createdAt");
ALTER TABLE "organization_security_policies" ADD CONSTRAINT "organization_security_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_devices" ADD CONSTRAINT "security_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_ip_rules" ADD CONSTRAINT "security_ip_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
