import { z } from "zod";
import { fail } from "../../shared/errors.js";
import { northResourceLimits } from "./limits.js";
import type { Transaction } from "../../shared/transaction.js";

const locale = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/);
const localized = z.record(locale, z.string().trim().min(1).max(10_000));
const resourceId = z.string().min(1).max(128);
const safeUrl = z.string().url().max(2_048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
}, "URL protocol is not allowed");

const breakpoint = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(100),
}).strict().refine((value) => value.x + value.w <= 12, "Grid item exceeds 12 columns");

export const northResponsiveLayout = z.object({
  desktop: breakpoint,
  tablet: breakpoint,
  mobile: breakpoint,
}).strict();

const bindingSchema = z.object({
  sourceType: z.enum(["metric", "dataset"]),
  sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).describe("For dataset sources, the authoritative analytics binding ID"),
  datasetId: resourceId.optional().describe("Required for dataset sources and checked against the binding-owned dataset"),
  viewId: resourceId.optional().describe("Deprecated compatibility field; ignored for authoritative dataset bindings"),
}).strict().superRefine((value, context) => {
  if (value.sourceType === "dataset" && !value.datasetId)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Dataset bindings require datasetId; sourceId is the authoritative binding ID" });
  if (value.sourceType === "metric" && (value.datasetId || value.viewId))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Metric bindings cannot carry dataset identifiers" });
});
const bindings = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), bindingSchema).default({});

const commonVariant = z.enum(["default", "primary", "secondary", "muted", "success", "warning", "danger"]);
const align = z.enum(["left", "center", "right"]);
const fit = z.enum(["contain", "cover", "fill"]);
const size = z.enum(["sm", "md", "lg"]);
const resultKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const safeChartColor = z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/);
const chartHeight = z.number().int().min(160).max(800);
const chartSeries = z.object({
  key: resultKey,
  label: localized,
  color: safeChartColor.optional(),
}).strict();

// Reusable analytics presentation vocabulary. Everything is data (enums and keys), never markup or expressions.
const tone = z.enum(["blue", "violet", "green", "amber", "rose", "cyan", "slate"]);
const iconName = z.enum(["container", "scale", "users", "buildings", "globe", "clock", "ship", "anchor", "pin", "chart", "package", "truck", "calendar", "trend", "warning", "star"]);
const valueFormat = z.enum(["number", "decimal", "percent", "text", "date", "month"]);
const kpiSubtitle = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text"), text: localized }).strict(),
  // "38.8% of the total": rows[0][valueKey] over the `total` binding's rows[0][totalKey].
  z.object({ mode: z.literal("share"), valueKey: resultKey, totalKey: resultKey, label: localized.optional() }).strict(),
  z.object({ mode: z.literal("relative_date") }).strict(),
]);
const gridColumn = z.object({
  key: resultKey,
  label: localized,
  kind: z.enum(["text", "number", "decimal", "date", "month", "bar", "badge", "sparkline", "actions"]).default("text"),
  align: align.optional(),
  width: z.number().int().min(48).max(640).optional(),
  sortable: z.boolean().optional(),
  hidden: z.boolean().optional(),
  // bar: the cell shows its share of the column maximum on the current page.
  barTone: tone.optional(),
}).strict();
const insightRule = z.discriminatedUnion("rule", [
  // The leading entity of a ranking and its share of the ranking total.
  z.object({ id: resourceId, rule: z.literal("leader_share"), binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), labelKey: resultKey, valueKey: resultKey, title: localized, tone: tone.optional(), icon: iconName.optional() }).strict(),
  // Period over period change of the first row's value (needs a closed date range selected and compareBy on the binding).
  z.object({ id: resourceId, rule: z.literal("period_change"), binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), valueKey: resultKey, title: localized, tone: tone.optional(), icon: iconName.optional() }).strict(),
  // Share of the top N entries of a ranking.
  z.object({ id: resourceId, rule: z.literal("top_concentration"), binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), labelKey: resultKey, valueKey: resultKey, top: z.number().int().min(1).max(10), title: localized, tone: tone.optional(), icon: iconName.optional() }).strict(),
]);

const catalog = {
  heading: z.object({ text: localized, level: z.number().int().min(1).max(6), align: align.optional(), variant: commonVariant.optional() }).strict(),
  rich_text: z.object({ documents: z.record(locale, z.unknown()), variant: commonVariant.optional() }).strict(),
  image: z.object({ assetId: resourceId, alt: localized, caption: localized.optional(), fit: fit.optional() }).strict(),
  video: z.object({ assetId: resourceId, title: localized.optional(), controls: z.boolean().optional(), fit: fit.optional() }).strict(),
  link: z.object({ label: localized, href: safeUrl, variant: commonVariant.optional(), size: size.optional(), openInNewTab: z.boolean().optional() }).strict(),
  file: z.object({ assetId: resourceId, label: localized }).strict(),
  table: z.object({ columns: z.array(z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), label: localized }).strict()).min(1).max(50), rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(1_000), striped: z.boolean().optional() }).strict(),
  card: z.object({ title: localized, body: localized.optional(), assetId: resourceId.optional(), variant: commonVariant.optional() }).strict(),
  list: z.object({ ordered: z.boolean().optional(), items: z.array(z.object({ id: resourceId, text: localized, href: safeUrl.optional() }).strict()).min(1).max(200) }).strict(),
  metric: z.object({ label: localized, value: z.union([z.string().max(500), z.number()]).optional(), fieldKey: resultKey.optional(), format: z.enum(["number", "currency", "percent", "duration", "text"]).optional(), variant: commonVariant.optional() }).strict(),
  bar_chart: z.object({ title: localized.optional(), categoryKey: resultKey, series: z.array(chartSeries).min(1).max(12), height: chartHeight.optional(), horizontal: z.boolean().optional(), variant: z.enum(["grouped", "stacked"]).optional(), showValues: z.boolean().optional(), valueFormat: valueFormat.optional() }).strict(),
  line_chart: z.object({ title: localized.optional(), categoryKey: resultKey, series: z.array(chartSeries).min(1).max(12), height: chartHeight.optional(), variant: z.enum(["line", "area"]).optional() }).strict(),
  donut_chart: z.object({ title: localized.optional(), categoryKey: resultKey, valueKey: resultKey, maxSlices: z.number().int().min(2).max(12).optional(), totalKey: resultKey.optional(), color: safeChartColor.optional(), height: chartHeight.optional(), variant: z.enum(["donut", "pie"]).optional(), centerLabel: localized.optional(), showTotal: z.boolean().optional(), legend: z.enum(["right", "bottom", "none"]).optional() }).strict(),
  // Interactive tenant document workspace (list, editor, PDF, delivery). Renders only for authenticated members;
  // all data and permissions come from the /documents contracts, never from this document.
  document_workspace: z.object({ typeKey: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), title: localized.optional() }).strict(),
  divider: z.object({ variant: z.enum(["solid", "dashed", "dotted"]).optional(), spacing: size.optional() }).strict(),
  embed: z.object({ url: z.string().url().max(2_048), title: localized.optional(), aspectRatio: z.enum(["16:9", "4:3", "1:1"]).optional() }).strict(),
  // KPI Card Pro: icon, value, unit, subtitle, period comparison and tooltip over one binding (`data`; optional `total`).
  kpi_card: z.object({
    label: localized,
    valueKey: resultKey,
    format: valueFormat.default("number"),
    decimals: z.number().int().min(0).max(6).optional(),
    unit: localized.optional(),
    icon: iconName.optional(),
    tone: tone.optional(),
    variant: z.enum(["compact", "standard", "trend", "comparison"]).default("standard"),
    subtitle: kpiSubtitle.optional(),
    // Compare with the previous period computed by CORECROW (binding needs compareBy); hidden when no comparison exists.
    comparison: z.object({ label: localized.optional(), inverse: z.boolean().optional() }).strict().optional(),
    tooltip: localized.optional(),
  }).strict(),
  // Advanced data grid over one paged binding (`data`) with an optional `trend` binding for real sparklines.
  data_grid: z.object({
    title: localized.optional(),
    columns: z.array(gridColumn).min(1).max(30),
    pageSizes: z.array(z.number().int().min(5).max(200)).min(1).max(5).default([10, 20, 50]),
    defaultPageSize: z.number().int().min(5).max(200).default(20),
    defaultSort: z.object({ key: resultKey, direction: z.enum(["ASC", "DESC"]) }).strict().optional(),
    searchable: z.boolean().default(true),
    selectable: z.boolean().default(false),
    exportable: z.boolean().default(true),
    inspectorKeys: z.array(resultKey).max(30).optional(),
    // Sparkline cells: one point per `categoryKey` bucket of `valueKey`, rows matched on `rowKeys`.
    trend: z.object({ binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), rowKeys: z.array(resultKey).min(1).max(3), categoryKey: resultKey, valueKey: resultKey }).strict().optional(),
    height: z.number().int().min(240).max(1_200).optional(),
  }).strict(),
  // Country bubble map: aggregated by a region key holding country names/ISO codes; never invents coordinates.
  geo_map: z.object({
    title: localized.optional(),
    regionKey: resultKey,
    valueKey: resultKey,
    secondaryKey: resultKey.optional(),
    valueLabel: localized.optional(),
    secondaryLabel: localized.optional(),
    tone: tone.optional(),
    height: chartHeight.optional(),
  }).strict(),
  // Places the page's filter bar (selectors, period, chips) at this spot instead of the default top position.
  filter_bar: z.object({ title: localized.optional() }).strict(),
  // Deterministic findings computed from binding results (no generative text).
  insights: z.object({ title: localized.optional(), items: z.array(insightRule).min(1).max(6) }).strict(),
} as const;

export const northComponentTypes = Object.freeze(Object.keys(catalog) as Array<keyof typeof catalog>);
export type NorthComponentType = (typeof northComponentTypes)[number];

export const northPanelDocumentInput = z.object({
  schemaVersion: z.literal(1),
  defaultLocale: locale,
  fallbackLocales: z.array(locale).max(10).default([]),
  sections: z.array(z.object({
    id: resourceId,
    name: localized.optional(),
    order: z.number().int().min(0).max(100_000),
    layout: z.object({ variant: z.literal("grid").default("grid"), gap: z.enum(["none", "sm", "md", "lg"]).default("md") }).strict(),
    components: z.array(z.object({
      id: resourceId,
      type: z.string().min(1).max(64),
      schemaVersion: z.number().int().min(1),
      props: z.record(z.string(), z.unknown()),
      bindings,
      layout: northResponsiveLayout,
      order: z.number().int().min(0).max(100_000),
    }).strict()).max(10_000),
  }).strict()).max(10_000),
}).strict();

export type NorthPanelDocument = z.infer<typeof northPanelDocumentInput>;

export type NorthAssetReferenceValidator = (
  organizationId: string,
  assetId: string,
  actorId: string,
  tx?: Transaction,
) => Promise<boolean>;
export type NorthBindingReferenceValidator = (
  organizationId: string,
  binding: z.infer<typeof bindingSchema>,
  actorId: string,
  tx?: Transaction,
  panelId?: string,
) => Promise<boolean>;

export const northComponentRegistry = Object.freeze(
  Object.fromEntries(northComponentTypes.map((type) => [`${type}@1`, {
    type,
    schemaVersion: 1 as const,
    validate: (value: unknown) => catalog[type].safeParse(value),
    migrate: (value: unknown) => value,
  }])) as Record<string, {
    type: NorthComponentType;
    schemaVersion: 1;
    validate: (value: unknown) => ReturnType<(typeof catalog)[NorthComponentType]["safeParse"]>;
    migrate: (value: unknown) => unknown;
  }>,
);

const richNodeTypes = new Set(["doc", "paragraph", "heading", "bullet_list", "ordered_list", "list_item", "text", "link", "asset", "table", "table_row", "table_cell"]);
const richMarks = new Set(["bold", "italic", "underline", "link"]);

function validateRichNode(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 30)
    fail(422, "RICH_TEXT_INVALID", "Rich text document is invalid");
  const node = value as Record<string, unknown>;
  const keys = Object.keys(node);
  if (keys.some((key) => !["type", "text", "level", "href", "assetId", "marks", "content"].includes(key)))
    fail(422, "RICH_TEXT_INVALID", "Rich text contains an unsupported field");
  if (typeof node.type !== "string" || !richNodeTypes.has(node.type))
    fail(422, "RICH_TEXT_INVALID", "Rich text contains an unsupported node");
  if (node.type === "doc" && depth !== 0) fail(422, "RICH_TEXT_INVALID", "Nested document nodes are not allowed");
  if (node.type === "text") {
    if (typeof node.text !== "string" || node.text.length > 20_000) fail(422, "RICH_TEXT_INVALID", "Text node is invalid");
    if (node.content !== undefined) fail(422, "RICH_TEXT_INVALID", "Text nodes cannot contain child nodes");
  }
  if (node.href !== undefined && !safeUrl.safeParse(node.href).success) fail(422, "RICH_TEXT_INVALID", "Rich text link is invalid");
  if (node.assetId !== undefined && !resourceId.safeParse(node.assetId).success) fail(422, "RICH_TEXT_INVALID", "Rich text asset is invalid");
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks) || node.marks.some((mark) => typeof mark !== "string" || !richMarks.has(mark)))
      fail(422, "RICH_TEXT_INVALID", "Rich text mark is not allowed");
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content) || node.content.length > 2_000) fail(422, "RICH_TEXT_INVALID", "Rich text children are invalid");
    for (const child of node.content) validateRichNode(child, depth + 1);
  }
}

function assertNoExecutableContent(value: unknown): void {
  if (typeof value === "string" && (/<\/?[a-z][^>]*>/i.test(value) || /\bon[a-z]+\s*=/i.test(value)))
    fail(422, "CONTENT_EXECUTABLE_NOT_ALLOWED", "Stored HTML, CSS, JavaScript, and event handlers are not allowed");
  if (Array.isArray(value)) for (const item of value) assertNoExecutableContent(item);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(html|css|javascript|script|style|sql|query|credentials?|password|secret|token|headers?)$/i.test(key))
        fail(422, "CONTENT_EXECUTABLE_NOT_ALLOWED", "Executable content and credentials are not allowed");
      assertNoExecutableContent(item);
    }
  }
}

function collectAssetIds(type: NorthComponentType, props: Record<string, unknown>, output: Set<string>) {
  if (["image", "video", "file"].includes(type) && typeof props.assetId === "string") output.add(props.assetId);
  if (type === "card" && typeof props.assetId === "string") output.add(props.assetId);
  if (type === "rich_text") {
    const visit = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.type === "asset" && typeof record.assetId === "string") output.add(record.assetId);
        Object.values(record).forEach(visit);
      }
    };
    visit(props.documents);
  }
}

function embedAllowed(value: string) {
  const configured = process.env.NORTH_EMBED_ALLOWED_DOMAINS?.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const allowed = configured?.length ? configured : ["youtube.com", "youtu.be", "vimeo.com", "lookerstudio.google.com"];
  const url = new URL(value);
  return url.protocol === "https:" && allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

export async function validateNorthPanelDocument(
  value: unknown,
  context: {
    organizationId: string;
    actorId: string;
    tx?: Transaction;
    validateAssetReference?: NorthAssetReferenceValidator;
    validateBindingReference?: NorthBindingReferenceValidator;
    panelId?: string;
  },
): Promise<NorthPanelDocument> {
  const parsed = northPanelDocumentInput.safeParse(value);
  if (!parsed.success) fail(422, "PANEL_DOCUMENT_INVALID", "Panel document schema is invalid");
  const document = parsed.data;
  if (new Set([document.defaultLocale, ...document.fallbackLocales]).size !== 1 + document.fallbackLocales.length)
    fail(422, "LOCALE_FALLBACK_INVALID", "Locale fallback entries must be unique");
  const limits = northResourceLimits();
  if (document.sections.length > limits.sectionsPerPanel)
    fail(422, "PANEL_SECTION_LIMIT_EXCEEDED", `Panel cannot contain more than ${limits.sectionsPerPanel} sections`);
  const sections = new Set<string>();
  const components = new Set<string>();
  const assets = new Set<string>();
  const bindingReferences: Array<z.infer<typeof bindingSchema>> = [];
  let componentCount = 0;
  assertNoExecutableContent(document);
  for (const section of document.sections) {
    if (sections.has(section.id)) fail(422, "PANEL_DOCUMENT_INVALID", "Section IDs must be unique");
    sections.add(section.id);
    componentCount += section.components.length;
    for (const component of section.components) {
      if (components.has(component.id)) fail(422, "PANEL_DOCUMENT_INVALID", "Component IDs must be unique");
      components.add(component.id);
      const key = `${component.type}@${component.schemaVersion}`;
      if (!Object.hasOwn(northComponentRegistry, key)) fail(422, "COMPONENT_SCHEMA_UNKNOWN", "Component type or schema version is not registered");
      const type = component.type as NorthComponentType;
      const props = northComponentRegistry[key]!.validate(component.props);
      if (!props.success) fail(422, "COMPONENT_SCHEMA_INVALID", "Component props do not match the registered schema");
      if (type === "rich_text") for (const richDocument of Object.values((props.data as { documents: Record<string, unknown> }).documents)) validateRichNode(richDocument);
      if (type === "embed" && !embedAllowed((props.data as { url: string }).url)) fail(422, "EMBED_DOMAIN_NOT_ALLOWED", "Embed domain is not allowed");
      collectAssetIds(type, props.data as Record<string, unknown>, assets);
      bindingReferences.push(...Object.values(component.bindings));
    }
  }
  if (componentCount > limits.componentsPerPanel) fail(422, "PANEL_COMPONENT_LIMIT_EXCEEDED", `Panel cannot contain more than ${limits.componentsPerPanel} components`);
  if (assets.size) {
    if (!context.validateAssetReference) fail(422, "ASSET_VALIDATION_UNAVAILABLE", "Asset references cannot be validated");
    for (const assetId of assets)
      if (!(await context.validateAssetReference(context.organizationId, assetId, context.actorId, context.tx)))
        fail(422, "CROSS_TENANT_RESOURCE", "Asset is outside the organization or unavailable");
  }
  if (bindingReferences.length) {
    if (!context.validateBindingReference) fail(422, "BINDING_VALIDATION_UNAVAILABLE", "Binding references cannot be validated");
    for (const reference of bindingReferences)
      if (!(await context.validateBindingReference(context.organizationId, reference, context.actorId, context.tx, context.panelId)))
        fail(422, "BINDING_NOT_ALLOWED", "Binding source is unavailable or unauthorized");
  }
  return document;
}
