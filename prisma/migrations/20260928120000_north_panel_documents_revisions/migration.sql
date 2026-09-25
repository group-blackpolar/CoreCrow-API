-- TASK 8C/8D: immutable, whole-panel revision snapshots. Section and component
-- structures remain inside the validated document so a revision is independently
-- reconstructible and publication points at one exact immutable snapshot.
CREATE TABLE "NorthPanelRevision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "etag" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "defaultLocale" TEXT NOT NULL,
    "fallbackLocales" JSONB NOT NULL,
    "message" TEXT,
    "publishAt" TIMESTAMP(3),
    "unpublishAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NorthPanelRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NorthPanelRevision_etag_key" ON "NorthPanelRevision"("etag");
CREATE UNIQUE INDEX "NorthPanelRevision_id_panelId_key" ON "NorthPanelRevision"("id", "panelId");
CREATE UNIQUE INDEX "NorthPanelRevision_panelId_revisionNumber_key" ON "NorthPanelRevision"("panelId", "revisionNumber");
CREATE INDEX "NorthPanelRevision_organizationId_panelId_revisionNumber_idx" ON "NorthPanelRevision"("organizationId", "panelId", "revisionNumber");

ALTER TABLE "NorthPanelRevision" ADD CONSTRAINT "NorthPanelRevision_panelId_organizationId_fkey"
  FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthPanelRevision" ADD CONSTRAINT "NorthPanelRevision_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A pointer cannot reference another panel's revision even if a caller bypasses
-- the application service. Existing system panels intentionally retain null
-- pointers because their implementation-backed content is not editable content.
ALTER TABLE "NorthPanel" ADD CONSTRAINT "NorthPanel_publishedRevisionId_id_fkey"
  FOREIGN KEY ("publishedRevisionId", "id") REFERENCES "NorthPanelRevision"("id", "panelId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthPanel" ADD CONSTRAINT "NorthPanel_draftRevisionId_id_fkey"
  FOREIGN KEY ("draftRevisionId", "id") REFERENCES "NorthPanelRevision"("id", "panelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NorthPanelRevision" ADD CONSTRAINT "NorthPanelRevision_number_check" CHECK ("revisionNumber" > 0);
ALTER TABLE "NorthPanelRevision" ADD CONSTRAINT "NorthPanelRevision_fallback_locales_array_check" CHECK (jsonb_typeof("fallbackLocales") = 'array');
ALTER TABLE "NorthPanelRevision" ADD CONSTRAINT "NorthPanelRevision_document_object_check" CHECK (jsonb_typeof("document") = 'object');
