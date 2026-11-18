-- ADR 029: evaluations engine. Additive (3 enums, 6 tables). Tenant integrity is enforced by composite foreign keys.
-- Rollback: DROP TABLE "EvaluationResult","EvaluationAnswer","EvaluationAttempt","EvaluationAssignment","EvaluationVersion","Evaluation";
--           DROP FUNCTION reject_evaluation_version_mutation(); DROP TYPE "EvaluationAttemptStatus","EvaluationStatus","EvaluationKind";
CREATE TYPE "EvaluationKind" AS ENUM ('EXAM', 'FORM');
CREATE TYPE "EvaluationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "EvaluationAttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED');

CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "EvaluationKind" NOT NULL DEFAULT 'EXAM',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "EvaluationStatus" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "currentVersionId" TEXT,
    "publishedRevision" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Evaluation_id_organizationId_key" ON "Evaluation"("id", "organizationId");
CREATE INDEX "Evaluation_organizationId_status_updatedAt_idx" ON "Evaluation"("organizationId", "status", "updatedAt");

CREATE TABLE "EvaluationVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "maxScoreCenti" INTEGER NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvaluationVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvaluationVersion_evaluationId_version_key" ON "EvaluationVersion"("evaluationId", "version");
CREATE UNIQUE INDEX "EvaluationVersion_id_evaluationId_organizationId_key" ON "EvaluationVersion"("id", "evaluationId", "organizationId");

CREATE TABLE "EvaluationAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "role" "TenantRole",
    "groupId" TEXT,
    "membershipId" TEXT,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    CONSTRAINT "EvaluationAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvaluationAssignment_one_subject_check" CHECK ((("role" IS NOT NULL)::int + ("groupId" IS NOT NULL)::int + ("membershipId" IS NOT NULL)::int) = 1),
    CONSTRAINT "EvaluationAssignment_window_check" CHECK ("opensAt" IS NULL OR "closesAt" IS NULL OR "opensAt" < "closesAt")
);
CREATE INDEX "EvaluationAssignment_organizationId_evaluationId_idx" ON "EvaluationAssignment"("organizationId", "evaluationId");
CREATE UNIQUE INDEX "EvaluationAssignment_role_key" ON "EvaluationAssignment"("evaluationId", "role") WHERE "role" IS NOT NULL;
CREATE UNIQUE INDEX "EvaluationAssignment_group_key" ON "EvaluationAssignment"("evaluationId", "groupId") WHERE "groupId" IS NOT NULL;
CREATE UNIQUE INDEX "EvaluationAssignment_membership_key" ON "EvaluationAssignment"("evaluationId", "membershipId") WHERE "membershipId" IS NOT NULL;

CREATE TABLE "EvaluationAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "EvaluationAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EvaluationAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvaluationAttempt_evaluationId_userId_attemptNumber_key" ON "EvaluationAttempt"("evaluationId", "userId", "attemptNumber");
CREATE UNIQUE INDEX "EvaluationAttempt_id_organizationId_key" ON "EvaluationAttempt"("id", "organizationId");
-- At most one open attempt per person and evaluation, enforced by the database (a double click or two tabs cannot open two).
CREATE UNIQUE INDEX "EvaluationAttempt_one_open_key" ON "EvaluationAttempt"("evaluationId", "userId") WHERE "status" = 'IN_PROGRESS';
CREATE INDEX "EvaluationAttempt_organizationId_evaluationId_status_idx" ON "EvaluationAttempt"("organizationId", "evaluationId", "status");
CREATE INDEX "EvaluationAttempt_userId_organizationId_idx" ON "EvaluationAttempt"("userId", "organizationId");

CREATE TABLE "EvaluationAnswer" (
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "optionId" TEXT,
    "seq" INTEGER NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvaluationAnswer_pkey" PRIMARY KEY ("attemptId", "questionId")
);

CREATE TABLE "EvaluationResult" (
    "attemptId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "correct" INTEGER NOT NULL,
    "incorrect" INTEGER NOT NULL,
    "unanswered" INTEGER NOT NULL,
    "scoreCenti" INTEGER NOT NULL,
    "maxScoreCenti" INTEGER NOT NULL,
    "timeUsedSeconds" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("attemptId")
);
CREATE INDEX "EvaluationResult_organizationId_evaluationId_idx" ON "EvaluationResult"("organizationId", "evaluationId");

-- Tenant-matching foreign keys.
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "EvaluationVersion" ADD CONSTRAINT "EvaluationVersion_evaluation_fkey" FOREIGN KEY ("evaluationId", "organizationId") REFERENCES "Evaluation"("id", "organizationId") ON DELETE RESTRICT;
ALTER TABLE "EvaluationVersion" ADD CONSTRAINT "EvaluationVersion_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_currentVersion_fkey" FOREIGN KEY ("currentVersionId", "id", "organizationId") REFERENCES "EvaluationVersion"("id", "evaluationId", "organizationId") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EvaluationAssignment" ADD CONSTRAINT "EvaluationAssignment_evaluation_fkey" FOREIGN KEY ("evaluationId", "organizationId") REFERENCES "Evaluation"("id", "organizationId") ON DELETE CASCADE;
ALTER TABLE "EvaluationAssignment" ADD CONSTRAINT "EvaluationAssignment_group_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "OrganizationGroup"("id", "organizationId") ON DELETE CASCADE;
ALTER TABLE "EvaluationAssignment" ADD CONSTRAINT "EvaluationAssignment_membership_fkey" FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE;
ALTER TABLE "EvaluationAttempt" ADD CONSTRAINT "EvaluationAttempt_version_fkey" FOREIGN KEY ("versionId", "evaluationId", "organizationId") REFERENCES "EvaluationVersion"("id", "evaluationId", "organizationId") ON DELETE RESTRICT;
ALTER TABLE "EvaluationAttempt" ADD CONSTRAINT "EvaluationAttempt_user_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "EvaluationAnswer" ADD CONSTRAINT "EvaluationAnswer_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "EvaluationAttempt"("id") ON DELETE RESTRICT;
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_attempt_fkey" FOREIGN KEY ("attemptId", "organizationId") REFERENCES "EvaluationAttempt"("id", "organizationId") ON DELETE RESTRICT;

-- A published version (content + answer key) is append-only at the persistence boundary.
CREATE FUNCTION reject_evaluation_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EvaluationVersion is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EvaluationVersion_reject_update_delete" BEFORE UPDATE OR DELETE ON "EvaluationVersion" FOR EACH ROW EXECUTE FUNCTION reject_evaluation_version_mutation();
CREATE TRIGGER "EvaluationVersion_reject_truncate" BEFORE TRUNCATE ON "EvaluationVersion" FOR EACH STATEMENT EXECUTE FUNCTION reject_evaluation_version_mutation();
