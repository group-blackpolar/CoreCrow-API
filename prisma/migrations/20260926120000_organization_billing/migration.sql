CREATE TYPE "BillingStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED');

CREATE TABLE "OrganizationBillingProfile" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "status" "BillingStatus" NOT NULL DEFAULT 'ACTIVE',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "basePriceMinor" INTEGER NOT NULL DEFAULT 1400,
  "memberPriceMinor" INTEGER NOT NULL DEFAULT 500,
  "billingEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationBillingProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationBillingProfile_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrganizationBillingProfile_prices_check"
    CHECK ("basePriceMinor" = 1400 AND "memberPriceMinor" = 500 AND "currency" = 'USD')
);

CREATE UNIQUE INDEX "OrganizationBillingProfile_organizationId_key"
  ON "OrganizationBillingProfile"("organizationId");
CREATE INDEX "OrganizationBillingProfile_status_idx"
  ON "OrganizationBillingProfile"("status");

INSERT INTO "OrganizationBillingProfile" (
  "id", "organizationId", "status", "currency", "basePriceMinor",
  "memberPriceMinor", "createdAt", "updatedAt"
)
SELECT
  'bill_' || md5(random()::text || "id"), "id", 'ACTIVE', 'USD', 1400,
  500, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization"
ON CONFLICT ("organizationId") DO NOTHING;
