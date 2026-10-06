import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Prisma, prisma } from "./lib/database.js";
import type { Transaction } from "./shared/transaction.js";
import { validateNorthPanelDocument, type NorthPanelDocument } from "./modules/north/content-schema.js";
import { masterHouseCategory, masterHousePages } from "./seed-master-house-pages.js";
import { bootstrapNorthOrganization } from "./modules/north/service.js";

const decimal = z.string().regex(/^-?(?:\d+\.?\d*|\.\d+)$/).nullable();
const label = z.string().min(1).max(500);
const fixtureSchema = z.object({
  schemaVersion: z.literal(2),
  fixtureId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  source: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), sourceWorkbook: z.string().min(1).max(255), sanitization: z.string().min(1).max(500) }).strict(),
  rows: z.array(z.object({
    arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    master_carrier: label, master_consignee: label, master_metric_tons: decimal, master_port_arrival: label,
    master_port_departure: label, master_country_origin: label, master_teus: decimal, master_bill_number: label,
    container_number: label,
    house_carrier: label, house_consignee: label, house_metric_tons: decimal, house_port_arrival: label,
    house_port_departure: label, house_country_origin: label, house_teus: decimal, house_bill_number: label,
  }).strict()).min(1).max(20_000),
}).strict();

const text = (es: string, en: string) => ({ es, en });
const fieldDefinitions = [
  { key: "arrival_date", displayName: text("Fecha de llegada", "Arrival date"), canonicalType: "DATE" as const },
  { key: "master_carrier", displayName: text("Naviera Master", "Master carrier"), canonicalType: "TEXT" as const },
  { key: "master_consignee", displayName: text("Consignatario Master", "Master consignee"), canonicalType: "TEXT" as const },
  { key: "master_metric_tons", displayName: text("Toneladas métricas Master", "Master metric tons"), canonicalType: "DECIMAL" as const },
  { key: "master_port_arrival", displayName: text("Puerto de arribo Master", "Master port of arrival"), canonicalType: "TEXT" as const },
  { key: "master_port_departure", displayName: text("Puerto de salida Master", "Master port of departure"), canonicalType: "TEXT" as const },
  { key: "master_country_origin", displayName: text("País de origen Master", "Master country of origin"), canonicalType: "TEXT" as const },
  { key: "master_teus", displayName: text("TEUs Master", "Master TEUs"), canonicalType: "DECIMAL" as const },
  { key: "master_bill_number", displayName: text("BL Master", "Master bill of lading"), canonicalType: "TEXT" as const },
  { key: "container_number", displayName: text("Contenedor", "Container"), canonicalType: "TEXT" as const },
  { key: "house_carrier", displayName: text("Naviera House", "House carrier"), canonicalType: "TEXT" as const },
  { key: "house_consignee", displayName: text("Consignatario House", "House consignee"), canonicalType: "TEXT" as const },
  { key: "house_metric_tons", displayName: text("Toneladas métricas House", "House metric tons"), canonicalType: "DECIMAL" as const },
  { key: "house_port_arrival", displayName: text("Puerto de arribo House", "House port of arrival"), canonicalType: "TEXT" as const },
  { key: "house_port_departure", displayName: text("Puerto de salida House", "House port of departure"), canonicalType: "TEXT" as const },
  { key: "house_country_origin", displayName: text("País de origen House", "House country of origin"), canonicalType: "TEXT" as const },
  { key: "house_teus", displayName: text("TEUs House", "House TEUs"), canonicalType: "DECIMAL" as const },
  { key: "house_bill_number", displayName: text("BL House", "House bill of lading"), canonicalType: "TEXT" as const },
] as const;

function argumentsFrom(command: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (!token.startsWith("--")) throw new Error("Unexpected seed argument");
    const separator = token.indexOf("=");
    if (separator > 2) values.set(token.slice(2, separator), token.slice(separator + 1));
    else {
      const value = command[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      values.set(token.slice(2), value);
      index += 1;
    }
  }
  const email = values.get("email")?.trim().toLowerCase();
  const organizationSlug = values.get("organization-slug")?.trim().toLowerCase();
  const organizationName = values.get("organization-name")?.trim() ?? "Master House Demo";
  if (!email || !z.string().email().safeParse(email).success) throw new Error("A valid --email is required");
  if (!organizationSlug || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(organizationSlug)) throw new Error("A valid --organization-slug is required");
  if (organizationName.length < 2 || organizationName.length > 120) throw new Error("A valid --organization-name is required");
  // Optional comma-separated list of already registered and verified accounts that
  // receive read-only (VIEWER) membership. Existing roles are never downgraded.
  const viewerEmails = (values.get("viewer-emails") ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const viewer of viewerEmails) if (!z.string().email().safeParse(viewer).success) throw new Error("Invalid --viewer-emails entry");
  // Explicit publication choice: marks every Master House page SHOWCASE and enables the organization showcase.
  const publicShowcase = values.get("public-showcase") === "true";
  return { email, organizationSlug, organizationName, viewerEmails, publicShowcase };
}

function etagFor(id: string, panelId: string, revisionNumber: number) {
  return `"${createHash("sha256").update(`${id}:${panelId}:${revisionNumber}`).digest("base64url")}"`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

type BindingDefinition = { key: string; name: string; query: Prisma.InputJsonValue };

async function upsertBinding(tx: Transaction, input: {
  organizationId: string; panelId: string; datasetId: string; userId: string;
  definition: BindingDefinition; allowedFilters: Prisma.InputJsonValue;
}) {
  const current = await tx.northAnalyticsBinding.findFirst({
    where: { organizationId: input.organizationId, panelId: input.panelId, name: input.definition.name },
  });
  const data = { datasetId: input.datasetId, query: input.definition.query, allowedFilters: input.allowedFilters };
  if (current) return tx.northAnalyticsBinding.update({ where: { id: current.id }, data });
  return tx.northAnalyticsBinding.create({ data: {
    organizationId: input.organizationId, panelId: input.panelId, createdBy: input.userId,
    name: input.definition.name, ...data,
  } });
}

function responsive(x: number, y: number, w: number, h: number, mobileY: number) {
  return {
    desktop: { x, y, w, h }, tablet: { x: x >= 6 ? 6 : 0, y, w: 6, h },
    mobile: { x: 0, y: mobileY, w: 12, h },
  };
}

function panelDocument(datasetId: string, fields: Map<string, string>, bindings: Map<string, string>): NorthPanelDocument {
  const reference = (key: string) => ({ sourceType: "dataset" as const, sourceId: bindings.get(key)!, datasetId });
  const component = (id: string, type: string, props: Record<string, unknown>, bindingKey: string | null, layout: ReturnType<typeof responsive>, order: number) => {
    const componentBindings: NorthPanelDocument["sections"][number]["components"][number]["bindings"] = bindingKey ? { result: reference(bindingKey) } : {};
    return { id, type, schemaVersion: 1, props, bindings: componentBindings, layout, order };
  };
  const localized = (es: string, en: string) => ({ es, en });
  return {
    schemaVersion: 1,
    defaultLocale: "es",
    fallbackLocales: ["en"],
    sections: [{
      id: "master-house-june-summary", name: localized("Resumen de junio de 2026", "June 2026 summary"), order: 0,
      layout: { variant: "grid", gap: "md" },
      components: [
        component("master-house-heading", "heading", { text: localized("Master House · Junio 2026", "Master House · June 2026"), level: 2 }, null, responsive(0, 0, 12, 1, 0), 0),
        component("total-records", "metric", { label: localized("Registros", "Records"), fieldKey: "total_records", format: "number" }, "total-records", responsive(0, 1, 3, 2, 1), 1),
        component("unique-containers", "metric", { label: localized("Contenedores únicos", "Unique containers"), fieldKey: "unique_containers", format: "number" }, "unique-containers", responsive(3, 1, 3, 2, 3), 2),
        component("unique-bills", "metric", { label: localized("BL maestros", "Master bills"), fieldKey: "unique_master_bills", format: "number" }, "unique-bills", responsive(6, 1, 3, 2, 5), 3),
        component("unique-consignees", "metric", { label: localized("Consignatarios", "Consignees"), fieldKey: "unique_consignees", format: "number" }, "unique-consignees", responsive(9, 1, 3, 2, 7), 4),
        component("daily-arrivals", "line_chart", { title: localized("Contenedores por fecha de llegada", "Containers by arrival date"), categoryKey: fields.get("arrival_date")!, series: [{ key: "containers", label: localized("Contenedores", "Containers"), color: "#0F766E" }], height: 300, variant: "area" }, "daily-arrivals", responsive(0, 3, 8, 5, 9), 5),
        component("origin-countries", "donut_chart", { title: localized("Principales países de origen", "Top origin countries"), categoryKey: fields.get("master_country_origin")!, valueKey: "containers", color: "#14B8A6", height: 300, variant: "donut" }, "origin-countries", responsive(8, 3, 4, 5, 14), 6),
        component("carriers", "bar_chart", { title: localized("Contenedores por transportista", "Containers by carrier"), categoryKey: fields.get("master_carrier")!, series: [{ key: "containers", label: localized("Contenedores", "Containers"), color: "#2563EB" }], height: 320, horizontal: true, variant: "grouped" }, "carriers", responsive(0, 8, 12, 5, 19), 7),
      ],
    }],
  };
}

async function seed() {
  const command = process.argv.slice(2);
  const fixturePath = fileURLToPath(new URL("./fixtures/master-house-june-2026.json", import.meta.url));
  const bytes = await readFile(fixturePath);
  const fixture = fixtureSchema.parse(JSON.parse(bytes.toString("utf8")));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (command.length === 1 && command[0] === "--validate-only") {
    const fields = new Map<string, string>(fieldDefinitions.map((definition) => [definition.key, `demo-field-${definition.key}`]));
    const bindingKeys = ["total-records", "unique-containers", "unique-bills", "unique-consignees", "daily-arrivals", "origin-countries", "carriers"];
    const bindings = new Map(bindingKeys.map((key) => [key, `demo-binding-${key}`]));
    await validateNorthPanelDocument(panelDocument("demo-dataset", fields, bindings), {
      organizationId: "demo-organization", actorId: "demo-user", panelId: "demo-panel",
      validateBindingReference: async (_organizationId, reference) => reference.datasetId === "demo-dataset" && [...bindings.values()].includes(reference.sourceId),
    });
    for (const page of masterHousePages) {
      const pageFields = (key: string) => {
        const id = fields.get(key);
        if (!id) throw new Error(`Unknown field ${key}`);
        return id;
      };
      const pageBindings = new Map(page.bindings.map((binding) => [binding.key, `demo-binding-${page.panel.slug}-${binding.key}`]));
      for (const binding of page.bindings) binding.query(pageFields);
      for (const filter of page.filters) pageFields(filter.field);
      await validateNorthPanelDocument(page.document({ datasetId: "demo-dataset", id: pageFields, binding: (key) => pageBindings.get(key)! }), {
        organizationId: "demo-organization", actorId: "demo-user", panelId: `demo-panel-${page.panel.slug}`,
        validateBindingReference: async (_organizationId, reference) => reference.datasetId === "demo-dataset" && [...pageBindings.values()].includes(reference.sourceId),
      });
    }
    process.stdout.write(`${JSON.stringify({ fixtureId: fixture.fixtureId, checksum, rows: fixture.rows.length, pages: masterHousePages.length, status: "valid" })}\n`);
    return;
  }
  const options = argumentsFrom(command);

  // One trusted, idempotent unit of work: it inserts thousands of rows, so the 5 s Prisma default is far too short.
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: options.email } });
    if (!user || user.status !== "ACTIVE" || !user.emailVerified) throw new Error("Demo account must be active and verified");

    let organization = await tx.organization.findUnique({ where: { slug: options.organizationSlug } });
    let membership;
    if (!organization) {
      organization = await tx.organization.create({ data: { slug: options.organizationSlug, name: options.organizationName } });
      membership = await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: "OWNER" } });
      await tx.auditLog.create({ data: { actorId: user.id, organizationId: organization.id, action: "DEMO_ORGANIZATION_CREATED", targetType: "Organization", targetId: organization.id, metadata: { fixtureId: fixture.fixtureId } } });
    } else {
      membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: user.id } } });
      if (!membership) throw new Error("Demo account is not a member of the existing organization slug");
    }

    // Standard NORTH baseline (Home, Administration and the read grants that let
    // MEMBER/VIEWER roles see published content). Idempotent, same as organization creation.
    await bootstrapNorthOrganization(tx, organization.id);

    const category = await tx.northCategory.upsert({
      where: { organizationId_slug: { organizationId: organization.id, slug: "analytics" } },
      update: { name: { es: "Analítica", en: "Analytics" }, status: "ACTIVE", navigationHidden: false },
      create: { organizationId: organization.id, scope: "ORGANIZATION", resourceKind: "CONTENT", categoryClass: "CUSTOM", name: { es: "Analítica", en: "Analytics" }, slug: "analytics", order: 0 },
    });
    const subcategory = await tx.northSubcategory.upsert({
      where: { categoryId_slug: { categoryId: category.id, slug: "master-house" } },
      update: { name: { es: "Master House", en: "Master House" }, status: "ACTIVE", navigationHidden: false },
      create: { organizationId: organization.id, categoryId: category.id, resourceKind: "CONTENT", name: { es: "Master House", en: "Master House" }, slug: "master-house", order: 0 },
    });
    const panel = await tx.northPanel.upsert({
      where: { subcategoryId_slug: { subcategoryId: subcategory.id, slug: "june-2026" } },
      update: { name: { es: "Junio 2026", en: "June 2026" }, navigationHidden: false, audienceType: "ALL_MEMBERS" },
      create: { organizationId: organization.id, subcategoryId: subcategory.id, resourceKind: "CONTENT", name: { es: "Junio 2026", en: "June 2026" }, slug: "june-2026", order: 0, audienceType: "ALL_MEMBERS" },
    });
    const dataset = await tx.northDataset.upsert({
      where: { organizationId_slug: { organizationId: organization.id, slug: "master-house-june-2026" } },
      update: { status: "ACTIVE", name: { es: "Master House · Junio 2026", en: "Master House · June 2026" } },
      create: { organizationId: organization.id, createdBy: user.id, slug: "master-house-june-2026", name: { es: "Master House · Junio 2026", en: "Master House · June 2026" }, description: { es: "Datos sanitizados para la demostración pública.", en: "Sanitized data for the public demonstration." } },
    });

    const fields = new Map<string, string>();
    for (const definition of fieldDefinitions) {
      const field = await tx.northDatasetField.upsert({
        where: { datasetId_key: { datasetId: dataset.id, key: definition.key } },
        update: { displayName: definition.displayName, canonicalType: definition.canonicalType, nullable: true, status: "ACTIVE" },
        create: { organizationId: organization.id, datasetId: dataset.id, ...definition, nullable: true, status: "ACTIVE" },
      });
      fields.set(definition.key, field.id);
    }

    const storageKey = `trusted-demo-seed/${organization.id}/${fixture.fixtureId}/${checksum}`;
    let importJob = await tx.northDatasetImportJob.findUnique({ where: { storageKey } });
    if (!importJob) {
      const schemaMaximum = await tx.northDatasetSchemaVersion.aggregate({ where: { datasetId: dataset.id }, _max: { version: true } });
      const schemaVersion = await tx.northDatasetSchemaVersion.create({ data: {
        organizationId: organization.id, datasetId: dataset.id, version: (schemaMaximum._max.version ?? 0) + 1, createdBy: user.id,
        fields: { create: fieldDefinitions.map((definition, ordinal) => ({ datasetFieldId: fields.get(definition.key)!, canonicalType: definition.canonicalType, nullable: true, status: "ACTIVE", ordinal })) },
      } });
      importJob = await tx.northDatasetImportJob.create({ data: {
        organizationId: organization.id, datasetId: dataset.id, requestedBy: user.id, requestedMembershipId: membership.id,
        idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: `trusted-seed-${fixture.fixtureId}-${checksum.slice(0, 16)}`, requestHash: checksum,
        filename: fixture.source.sourceWorkbook, declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: BigInt(bytes.length), declaredChecksum: checksum,
        storageKey, status: "SUCCEEDED", scanStatus: "UNAVAILABLE", progress: 100, attempts: 1, confirmedAt: new Date(), completedAt: new Date(), activationRequestedBy: user.id,
      } });
      const mapping = await tx.northDatasetImportMappingVersion.create({ data: {
        organizationId: organization.id, datasetId: dataset.id, importId: importJob.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: user.id,
        definition: { trustedSeed: true, fields: fieldDefinitions.map((definition, sourceOrdinal) => ({ sourceOrdinal, action: "MAP", fieldId: fields.get(definition.key), sourceKey: definition.key })) },
      } });
      await tx.northDatasetImportJob.update({ where: { id: importJob.id }, data: { activationMappingId: mapping.id } });
      const batchId = randomUUID();
      await tx.northDatasetImportBatch.create({ data: { id: batchId, organizationId: organization.id, datasetId: dataset.id, importId: importJob.id, schemaVersionId: schemaVersion.id, mappingVersionId: mapping.id, sheetOrdinal: 0, rowCount: fixture.rows.length, parserVersion: "trusted-demo-seed-v1" } });
      for (let offset = 0; offset < fixture.rows.length; offset += 500) {
        await tx.northDatasetRow.createMany({ data: fixture.rows.slice(offset, offset + 500).map((row, index) => ({
          id: randomUUID(), organizationId: organization.id, datasetId: dataset.id, batchId, ordinal: offset + index,
          values: Object.fromEntries(fieldDefinitions.map((definition) => [fields.get(definition.key)!, row[definition.key]])) as Prisma.InputJsonValue,
        })) });
      }
      const revisionMaximum = await tx.northDatasetRevision.aggregate({ where: { datasetId: dataset.id }, _max: { version: true } });
      const revision = await tx.northDatasetRevision.create({ data: { id: randomUUID(), organizationId: organization.id, datasetId: dataset.id, schemaVersionId: schemaVersion.id, version: (revisionMaximum._max.version ?? 0) + 1, mode: "REPLACE_DATASET", rowCount: fixture.rows.length, createdBy: user.id } });
      await tx.northDatasetRevisionBatch.create({ data: { organizationId: organization.id, datasetId: dataset.id, revisionId: revision.id, batchId, ordinal: 0 } });
      await tx.northDataset.update({ where: { id: dataset.id }, data: { currentSchemaVersionId: schemaVersion.id, activeRevisionId: revision.id } });
      await tx.auditLog.create({ data: { actorId: user.id, organizationId: organization.id, action: "NORTH_TRUSTED_DEMO_DATASET_SEEDED", targetType: "NorthDataset", targetId: dataset.id, metadata: { fixtureId: fixture.fixtureId, checksum, rowCount: fixture.rows.length, sourcePeriod: fixture.source.period, malwareScan: "not_applicable_trusted_seed", riskAccepted: true } } });
    }

    const allMembersAcl = await tx.northDatasetAcl.findFirst({ where: { organizationId: organization.id, datasetId: dataset.id, effect: "ALLOW", principalType: "ALL_MEMBERS" } });
    if (!allMembersAcl) await tx.northDatasetAcl.create({ data: { organizationId: organization.id, datasetId: dataset.id, effect: "ALLOW", principalType: "ALL_MEMBERS", createdBy: user.id } });

    const allowedFilters = [
      { fieldId: fields.get("arrival_date")!, operators: ["GTE", "LTE"] },
      { fieldId: fields.get("master_country_origin")!, operators: ["EQ"] },
      { fieldId: fields.get("master_carrier")!, operators: ["CONTAINS"] },
    ] as Prisma.InputJsonValue;
    const definitions: BindingDefinition[] = [
      { key: "total-records", name: "Demo: total records", query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "total_records" }] } },
      { key: "unique-containers", name: "Demo: unique containers", query: { mode: "AGGREGATE", measures: [{ operation: "COUNT_DISTINCT", fieldId: fields.get("container_number")!, alias: "unique_containers" }] } },
      { key: "unique-bills", name: "Demo: unique master bills", query: { mode: "AGGREGATE", measures: [{ operation: "COUNT_DISTINCT", fieldId: fields.get("master_bill_number")!, alias: "unique_master_bills" }] } },
      { key: "unique-consignees", name: "Demo: unique consignees", query: { mode: "AGGREGATE", measures: [{ operation: "COUNT_DISTINCT", fieldId: fields.get("master_consignee")!, alias: "unique_consignees" }] } },
      { key: "daily-arrivals", name: "Demo: daily arrivals", query: { mode: "AGGREGATE", groupBy: [fields.get("arrival_date")!], measures: [{ operation: "COUNT_DISTINCT", fieldId: fields.get("container_number")!, alias: "containers" }], orderBy: [{ key: fields.get("arrival_date")!, direction: "ASC" }], limit: 31 } },
      { key: "origin-countries", name: "Demo: origin countries", query: { mode: "AGGREGATE", groupBy: [fields.get("master_country_origin")!], measures: [{ operation: "COUNT_DISTINCT", fieldId: fields.get("container_number")!, alias: "containers" }], orderBy: [{ key: "containers", direction: "DESC" }], limit: 8 } },
      { key: "carriers", name: "Demo: carriers", query: { mode: "AGGREGATE", groupBy: [fields.get("master_carrier")!], measures: [{ operation: "COUNT_DISTINCT", fieldId: fields.get("container_number")!, alias: "containers" }], orderBy: [{ key: "containers", direction: "DESC" }], limit: 12 } },
    ];
    const bindings = new Map<string, string>();
    for (const definition of definitions) {
      const binding = await upsertBinding(tx, { organizationId: organization.id, panelId: panel.id, datasetId: dataset.id, userId: user.id, definition, allowedFilters });
      bindings.set(definition.key, binding.id);
    }

    const document = panelDocument(dataset.id, fields, bindings);
    const validated = await validateNorthPanelDocument(document, {
      organizationId: organization.id, actorId: user.id, tx, panelId: panel.id,
      validateBindingReference: async (organizationId, reference) => organizationId === organization!.id && reference.sourceType === "dataset" && reference.datasetId === dataset.id && [...bindings.values()].includes(reference.sourceId),
    });
    const published = await tx.northPanelRevision.findFirst({ where: { id: panel.publishedRevisionId ?? "", panelId: panel.id, organizationId: organization.id } });
    if (!published || !sameJson(published.document, validated)) {
      const maximum = await tx.northPanelRevision.aggregate({ where: { panelId: panel.id }, _max: { revisionNumber: true } });
      const revisionNumber = (maximum._max.revisionNumber ?? 0) + 1;
      const id = randomUUID();
      const revision = await tx.northPanelRevision.create({ data: { id, organizationId: organization.id, panelId: panel.id, revisionNumber, etag: etagFor(id, panel.id, revisionNumber), document: validated as unknown as Prisma.InputJsonValue, defaultLocale: validated.defaultLocale, fallbackLocales: validated.fallbackLocales, message: `Trusted demo seed ${fixture.fixtureId}`, createdBy: user.id } });
      await tx.northPanel.update({ where: { id: panel.id }, data: { status: "PUBLISHED", draftRevisionId: revision.id, publishedRevisionId: revision.id } });
      await tx.auditLog.create({ data: { actorId: user.id, organizationId: organization.id, action: "NORTH_DEMO_PANEL_PUBLISHED", targetType: "NorthPanel", targetId: panel.id, metadata: { fixtureId: fixture.fixtureId, revisionNumber } } });
    } else if (panel.status !== "PUBLISHED") {
      await tx.northPanel.update({ where: { id: panel.id }, data: { status: "PUBLISHED", draftRevisionId: published.id, publishedRevisionId: published.id } });
    }

    // --- Master House report pages: one subcategory + published panel per page. ---
    const fieldId = (key: string) => {
      const id = fields.get(key);
      if (!id) throw new Error(`Unknown field ${key}`);
      return id;
    };
    const mhCategory = await tx.northCategory.upsert({
      where: { organizationId_slug: { organizationId: organization.id, slug: masterHouseCategory.slug } },
      update: { name: masterHouseCategory.name, icon: masterHouseCategory.icon, status: "ACTIVE", navigationHidden: false },
      create: { organizationId: organization.id, scope: "ORGANIZATION", resourceKind: "CONTENT", categoryClass: "CUSTOM", name: masterHouseCategory.name, icon: masterHouseCategory.icon, slug: masterHouseCategory.slug, order: masterHouseCategory.order },
    });
    // Landing order for the demo: Master House first, the original single-panel summary
    // after it, and the empty system Home hidden. Administration keeps its own order.
    await tx.northCategory.updateMany({ where: { organizationId: organization.id, slug: "analytics" }, data: { order: 10 } });
    await tx.northCategory.updateMany({ where: { organizationId: organization.id, slug: "home", resourceKind: "SYSTEM" }, data: { navigationHidden: true } });
    let overviewPanelId: string | null = null;
    for (const page of masterHousePages) {
      const pageSubcategory = await tx.northSubcategory.upsert({
        where: { categoryId_slug: { categoryId: mhCategory.id, slug: page.subcategory.slug } },
        update: { name: page.subcategory.name, status: "ACTIVE", navigationHidden: false, order: page.subcategory.order },
        create: { organizationId: organization.id, categoryId: mhCategory.id, resourceKind: "CONTENT", name: page.subcategory.name, slug: page.subcategory.slug, order: page.subcategory.order },
      });
      const pagePanel = await tx.northPanel.upsert({
        where: { subcategoryId_slug: { subcategoryId: pageSubcategory.id, slug: page.panel.slug } },
        update: { name: page.panel.name, navigationHidden: false, audienceType: "ALL_MEMBERS", ...(options.publicShowcase ? { visibility: "SHOWCASE" as const } : {}) },
        create: { organizationId: organization.id, subcategoryId: pageSubcategory.id, resourceKind: "CONTENT", name: page.panel.name, slug: page.panel.slug, order: 0, audienceType: "ALL_MEMBERS", visibility: options.publicShowcase ? "SHOWCASE" : "PRIVATE" },
      });
      if (page.subcategory.order === 0) overviewPanelId = pagePanel.id;
      const pageAllowed = page.filters.map((filter) => ({ fieldId: fieldId(filter.field), operators: filter.operators })) as Prisma.InputJsonValue;
      const pageBindings = new Map<string, string>();
      for (const definition of page.bindings) {
        const binding = await upsertBinding(tx, {
          organizationId: organization.id, panelId: pagePanel.id, datasetId: dataset.id, userId: user.id, allowedFilters: pageAllowed,
          definition: { key: definition.key, name: definition.name, query: definition.query(fieldId) as Prisma.InputJsonValue },
        });
        pageBindings.set(definition.key, binding.id);
      }
      const pageValidated = await validateNorthPanelDocument(page.document({ datasetId: dataset.id, id: fieldId, binding: (key) => pageBindings.get(key)! }), {
        organizationId: organization.id, actorId: user.id, tx, panelId: pagePanel.id,
        validateBindingReference: async (organizationId, reference) => organizationId === organization!.id && reference.sourceType === "dataset" && reference.datasetId === dataset.id && [...pageBindings.values()].includes(reference.sourceId),
      });
      const pagePublished = await tx.northPanelRevision.findFirst({ where: { id: pagePanel.publishedRevisionId ?? "", panelId: pagePanel.id, organizationId: organization.id } });
      if (!pagePublished || !sameJson(pagePublished.document, pageValidated)) {
        const maximum = await tx.northPanelRevision.aggregate({ where: { panelId: pagePanel.id }, _max: { revisionNumber: true } });
        const revisionNumber = (maximum._max.revisionNumber ?? 0) + 1;
        const id = randomUUID();
        const revision = await tx.northPanelRevision.create({ data: { id, organizationId: organization.id, panelId: pagePanel.id, revisionNumber, etag: etagFor(id, pagePanel.id, revisionNumber), document: pageValidated as unknown as Prisma.InputJsonValue, defaultLocale: pageValidated.defaultLocale, fallbackLocales: pageValidated.fallbackLocales, message: `Trusted demo seed ${fixture.fixtureId}`, createdBy: user.id } });
        await tx.northPanel.update({ where: { id: pagePanel.id }, data: { status: "PUBLISHED", draftRevisionId: revision.id, publishedRevisionId: revision.id } });
        await tx.auditLog.create({ data: { actorId: user.id, organizationId: organization.id, action: "NORTH_DEMO_PANEL_PUBLISHED", targetType: "NorthPanel", targetId: pagePanel.id, metadata: { fixtureId: fixture.fixtureId, revisionNumber, page: page.subcategory.slug } } });
      } else if (pagePanel.status !== "PUBLISHED") {
        await tx.northPanel.update({ where: { id: pagePanel.id }, data: { status: "PUBLISHED", draftRevisionId: pagePublished.id, publishedRevisionId: pagePublished.id } });
      }
    }

    // --- Read-only viewers: existing, verified accounts only. Nothing is created and no role is changed. ---
    const viewers: Array<{ email: string; role: string; added: boolean }> = [];
    for (const viewerEmail of options.viewerEmails) {
      const viewer = await tx.user.findUnique({ where: { email: viewerEmail } });
      if (!viewer || viewer.status !== "ACTIVE" || !viewer.emailVerified) throw new Error(`Viewer ${viewerEmail} must be an active, verified account`);
      const existing = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: viewer.id } } });
      if (existing) { viewers.push({ email: viewerEmail, role: existing.role, added: false }); continue; }
      await tx.membership.create({ data: { organizationId: organization.id, userId: viewer.id, role: "VIEWER" } });
      await tx.auditLog.create({ data: { actorId: user.id, organizationId: organization.id, action: "DEMO_VIEWER_MEMBERSHIP_ADDED", targetType: "User", targetId: viewer.id, metadata: { fixtureId: fixture.fixtureId, role: "VIEWER" } } });
      viewers.push({ email: viewerEmail, role: "VIEWER", added: true });
    }

    await tx.organization.update({ where: { id: organization.id }, data: { homePanelId: overviewPanelId ?? panel.id, ...(options.publicShowcase ? { showcaseEnabled: true } : {}) } });
    if (options.publicShowcase)
      await tx.auditLog.create({ data: { actorId: user.id, organizationId: organization.id, action: "SHOWCASE_ENABLED", targetType: "Organization", targetId: organization.id, metadata: { fixtureId: fixture.fixtureId, pages: masterHousePages.length, synthetic: true } } });
    return { organizationId: organization.id, panelId: panel.id, datasetId: dataset.id, rows: fixture.rows.length, fixtureId: fixture.fixtureId, pages: masterHousePages.length, publicShowcase: options.publicShowcase, viewers };
  }, { isolationLevel: "Serializable", timeout: 300_000, maxWait: 15_000 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

seed().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Tenant demo seed failed"}\n`);
  await prisma.$disconnect();
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
