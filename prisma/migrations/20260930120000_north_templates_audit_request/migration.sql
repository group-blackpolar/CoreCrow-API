ALTER TABLE "AuditLog" ADD COLUMN "requestId" TEXT;

CREATE TABLE "NorthTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "status" "NorthResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NorthTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NorthTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NorthTemplate_slug_key" ON "NorthTemplate"("slug");
CREATE INDEX "NorthTemplate_status_slug_idx" ON "NorthTemplate"("status", "slug");
CREATE UNIQUE INDEX "NorthTemplateVersion_templateId_version_key" ON "NorthTemplateVersion"("templateId", "version");
CREATE INDEX "NorthTemplateVersion_templateId_createdAt_idx" ON "NorthTemplateVersion"("templateId", "createdAt");

ALTER TABLE "NorthTemplate"
ADD CONSTRAINT "NorthTemplate_createdBy_fkey"
FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthTemplateVersion"
ADD CONSTRAINT "NorthTemplateVersion_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "NorthTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthTemplateVersion"
ADD CONSTRAINT "NorthTemplateVersion_createdBy_fkey"
FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
