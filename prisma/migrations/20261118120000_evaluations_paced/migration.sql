-- ADR 029 addendum: paced (forward-only, per-question timed) attempts and idempotent importers. Additive.
-- Rollback: ALTER TABLE "EvaluationResult" DROP COLUMN "timedOut"; ALTER TABLE "EvaluationAnswer" DROP COLUMN "openedAt", DROP COLUMN "closedAt", DROP COLUMN "closure";
--           DROP INDEX "Evaluation_organizationId_key_key"; ALTER TABLE "Evaluation" DROP COLUMN "key";
ALTER TABLE "Evaluation" ADD COLUMN "key" TEXT;
CREATE UNIQUE INDEX "Evaluation_organizationId_key_key" ON "Evaluation"("organizationId", "key") WHERE "key" IS NOT NULL;
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_key_format_check" CHECK ("key" IS NULL OR "key" ~ '^[a-z0-9][a-z0-9-]{0,78}$');
ALTER TABLE "EvaluationAnswer" ADD COLUMN "openedAt" TIMESTAMP(3), ADD COLUMN "closedAt" TIMESTAMP(3), ADD COLUMN "closure" TEXT;
ALTER TABLE "EvaluationAnswer" ADD CONSTRAINT "EvaluationAnswer_closure_check" CHECK ("closure" IS NULL OR "closure" IN ('CONFIRMED', 'OMITTED', 'TIMEOUT'));
ALTER TABLE "EvaluationResult" ADD COLUMN "timedOut" INTEGER NOT NULL DEFAULT 0;
