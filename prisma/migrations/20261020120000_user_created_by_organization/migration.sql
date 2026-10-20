-- Marks accounts created by an organization administrator (login alias name@<slug>.bp). Additive, nullable.
-- Rollback: DROP INDEX "users_createdByOrganizationId_createdAt_idx"; ALTER TABLE "users" DROP COLUMN "createdByOrganizationId";
ALTER TABLE "users" ADD COLUMN "createdByOrganizationId" TEXT;
-- Backfill: organization-created accounts are exactly those whose address domain is <organization slug>.bp (".bp" is not a routable TLD).
UPDATE "users" u SET "createdByOrganizationId" = o."id"
FROM "Organization" o
WHERE lower(u."email") LIKE '%@' || lower(o."slug") || '.bp';
CREATE INDEX "users_createdByOrganizationId_createdAt_idx" ON "users"("createdByOrganizationId", "createdAt");
