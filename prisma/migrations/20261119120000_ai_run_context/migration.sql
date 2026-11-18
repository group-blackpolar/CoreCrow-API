-- Phase 7: optional page context a person chose to share with an assistant run. Additive, nullable.
-- Rollback: ALTER TABLE "AIRun" DROP COLUMN "context";
ALTER TABLE "AIRun" ADD COLUMN "context" JSONB;
