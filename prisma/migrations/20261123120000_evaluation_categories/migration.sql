-- ADR 032: evaluation categories (administrable, persistent) and append-only feedback versions per attempt. Additive.
-- Rollback: DROP TABLE "EvaluationFeedback"; ALTER TABLE "Evaluation" DROP COLUMN "categoryId"; DROP TABLE "EvaluationCategory";
CREATE TABLE "EvaluationCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#4f46e5',
    "imageAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EvaluationCategory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvaluationCategory_key_check" CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{0,78}$'),
    CONSTRAINT "EvaluationCategory_color_check" CHECK ("color" ~ '^#[0-9a-fA-F]{6}$'),
    CONSTRAINT "EvaluationCategory_status_check" CHECK ("status" IN ('ACTIVE', 'ARCHIVED'))
);
CREATE UNIQUE INDEX "EvaluationCategory_organizationId_key_key" ON "EvaluationCategory"("organizationId", "key");
CREATE UNIQUE INDEX "EvaluationCategory_id_organizationId_key" ON "EvaluationCategory"("id", "organizationId");
ALTER TABLE "EvaluationCategory" ADD CONSTRAINT "EvaluationCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
ALTER TABLE "EvaluationCategory" ADD CONSTRAINT "EvaluationCategory_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT;

ALTER TABLE "Evaluation" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_category_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "EvaluationCategory"("id", "organizationId") ON DELETE RESTRICT;

-- Feedback is generated from the graded attempt and never replaces an earlier one: version N+1 is a new row (who/why/how in the row itself).
CREATE TABLE "EvaluationFeedback" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "generator" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvaluationFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvaluationFeedback_attemptId_version_key" ON "EvaluationFeedback"("attemptId", "version");
ALTER TABLE "EvaluationFeedback" ADD CONSTRAINT "EvaluationFeedback_attempt_fkey" FOREIGN KEY ("attemptId", "organizationId") REFERENCES "EvaluationAttempt"("id", "organizationId") ON DELETE RESTRICT;
ALTER TABLE "EvaluationFeedback" ADD CONSTRAINT "EvaluationFeedback_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT;
