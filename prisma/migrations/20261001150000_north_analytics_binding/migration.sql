-- TD-03: authoritative panel-owned bindings over tenant datasets.
CREATE TABLE "NorthAnalyticsBinding" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "panelId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "query" JSONB NOT NULL,
  "allowedFilters" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NorthAnalyticsBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NorthAnalyticsBinding_name_check" CHECK (length("name") BETWEEN 1 AND 100),
  CONSTRAINT "NorthAnalyticsBinding_filters_array_check" CHECK (jsonb_typeof("allowedFilters") = 'array')
);

CREATE UNIQUE INDEX "NorthAnalyticsBinding_id_panel_org_key"
  ON "NorthAnalyticsBinding"("id", "panelId", "organizationId");
CREATE INDEX "NorthAnalyticsBinding_org_panel_created_idx"
  ON "NorthAnalyticsBinding"("organizationId", "panelId", "createdAt", "id");
CREATE INDEX "NorthAnalyticsBinding_org_dataset_idx"
  ON "NorthAnalyticsBinding"("organizationId", "datasetId");

ALTER TABLE "NorthAnalyticsBinding" ADD CONSTRAINT "NorthAnalyticsBinding_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthAnalyticsBinding" ADD CONSTRAINT "NorthAnalyticsBinding_panelId_org_fkey"
  FOREIGN KEY ("panelId", "organizationId") REFERENCES "NorthPanel"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthAnalyticsBinding" ADD CONSTRAINT "NorthAnalyticsBinding_datasetId_org_fkey"
  FOREIGN KEY ("datasetId", "organizationId") REFERENCES "NorthDataset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NorthAnalyticsBinding" ADD CONSTRAINT "NorthAnalyticsBinding_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
