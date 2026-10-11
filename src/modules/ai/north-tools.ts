// Real assistant tools for NORTH dashboards and structure. Every tool runs as the signed-in user through the SAME services
// the product uses (published-panel authorization, tenant dataset ACL, audience rules, declared binding allowlists), so the
// assistant can never see or do more than the account can. Nothing here queries a dataset directly or trusts the model for
// identifiers: panel and binding ids are re-authorized on every call.
import { z } from "zod";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { hasNorthCapability } from "../north/authorization.js";
import { northTaxonomy } from "../north/service.js";
import { northAnalyticsBindings } from "../north/data/binding-service.js";
import type { DatasetQueryFilter } from "../north/data/query-contract.js";
import type { RegisteredAITool } from "./tool-registry.js";

/** Instructions the NORTH client executes after a tool completes (validated again on the client; never code or markup). */
export type AIUiDirective =
  | { type: "open_panel"; panelId: string }
  | { type: "apply_filters"; panelId: string; replace: boolean; filters: Array<{ fieldKey: string; values?: Array<string | number | boolean>; text?: string; from?: string; to?: string }> }
  | { type: "clear_filters"; panelId: string };

const MAX_ROWS = 25;
const id = z.string().min(1).max(128);
const scalar = z.union([z.string().max(300), z.number(), z.boolean()]);
const filterInput = z.object({
  field: z.string().min(1).max(128).describe("Filter field KEY exactly as listed by views.panel.describe"),
  values: z.array(scalar).min(1).max(50).optional().describe("Exact values (use views.values.search to find the real spelling)"),
  contains: z.string().trim().min(1).max(200).optional().describe("Text contained in the value"),
  from: z.string().max(40).optional().describe("Range start, ISO date yyyy-mm-dd"),
  to: z.string().max(40).optional().describe("Range end (inclusive), ISO date yyyy-mm-dd"),
}).strict().refine((value) => Boolean(value.values || value.contains || value.from || value.to), "A filter needs values, contains, from or to");
type FilterInput = z.infer<typeof filterInput>;

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return String(record.es ?? record.en ?? Object.values(record).find((item) => typeof item === "string") ?? "");
};

type Described = Awaited<ReturnType<typeof northAnalyticsBindings.describePublished>>;
type DescribedBinding = Described["bindings"][number];
type DescribedFilter = DescribedBinding["filters"][number];

const describe = (userId: string, organizationId: string, panelId: string) => northAnalyticsBindings.describePublished(userId, organizationId, panelId);

function bindingNamed(described: Described, name: string): DescribedBinding {
  const found = described.bindings.find((binding) => binding.name === name);
  if (!found) fail(422, "AI_BINDING_UNKNOWN", `This panel has no data set named "${name}". Available: ${described.bindings.map((binding) => binding.name).join(", ") || "none"}`);
  return found;
}

function definitionOf(binding: DescribedBinding, key: string): DescribedFilter {
  const found = binding.filters.find((item) => item.key === key);
  if (!found) fail(422, "AI_FIELD_NOT_AVAILABLE", `The field "${key}" cannot be filtered in "${binding.name}". Filterable fields: ${binding.filters.map((item) => item.key).join(", ") || "none"}`);
  return found;
}

/** Same translation the NORTH filter bar performs: only operators the binding allows are ever produced. */
function toQueryFilters(binding: DescribedBinding, input: FilterInput): DatasetQueryFilter[] {
  const definition = definitionOf(binding, input.field);
  const ops = new Set(definition.operators);
  const { fieldId } = definition;
  const out: DatasetQueryFilter[] = [];
  if (input.values?.length) {
    if (input.values.length > 1 || !ops.has("EQ")) {
      if (!ops.has("IN")) fail(422, "AI_FILTER_NOT_ALLOWED", `"${input.field}" accepts a single value only`);
      out.push({ fieldId, operator: "IN", value: input.values });
    } else out.push({ fieldId, operator: "EQ", value: input.values[0]! });
  }
  if (input.contains) {
    // Never degrade a text search into an exact match (it would silently return nothing): the model must resolve exact values first.
    if (ops.has("CONTAINS")) out.push({ fieldId, operator: "CONTAINS", value: input.contains });
    else fail(422, "AI_FILTER_NOT_ALLOWED", `"${input.field}" cannot be searched by text; find the exact values with views.values.search and pass them as values`);
  }
  const day = (value: string) => (definition.type === "DATETIME" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (input.from) { if (!ops.has("GTE")) fail(422, "AI_FILTER_NOT_ALLOWED", `"${input.field}" has no range`); out.push({ fieldId, operator: "GTE", value: day(input.from) }); }
  if (input.to) { if (!ops.has("LTE")) fail(422, "AI_FILTER_NOT_ALLOWED", `"${input.field}" has no range`); out.push({ fieldId, operator: "LTE", value: input.to }); }
  return out;
}

const filtersFor = (binding: DescribedBinding, inputs: FilterInput[] | undefined) => (inputs ?? []).flatMap((item) => toQueryFilters(binding, item)).slice(0, 10);

/** The binding whose rows best represent "the results" of a panel: a paged grid first, then any ROWS/aggregate one. */
const primaryBinding = (described: Described) => described.bindings.find((binding) => binding.paged) ?? described.bindings[0];

const clip = (rows: Array<Record<string, unknown>>) => rows.slice(0, MAX_ROWS);

export const northAITools: RegisteredAITool[] = [
  {
    name: "views.navigation.list",
    description: "List the published dashboards (panels) the user may open, with their ids, categories and subcategories. Call it first to find the panel for a request. Optional text filters by name.",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({ query: z.string().trim().max(100).optional() }).strict(),
    handler: async (context, raw) => {
      const { query } = raw as { query?: string };
      const tree = await northTaxonomy.navigation(context.userId, context.organizationId);
      const needle = query?.toLowerCase();
      const panels = tree.flatMap((category) => category.subcategories.flatMap((subcategory) => subcategory.panels.map((panel) => ({
        panelId: panel.id, category: text(category.name), categorySlug: category.slug, subcategory: text(subcategory.name), subcategorySlug: subcategory.slug, panel: text(panel.name), panelSlug: panel.slug,
      })))).filter((item) => !needle || `${item.category} ${item.subcategory} ${item.panel}`.toLowerCase().includes(needle));
      return { count: panels.length, panels: panels.slice(0, 60) };
    },
  },
  {
    name: "views.panel.describe",
    description: "Describe one published dashboard: its components and, for every data set (binding) it exposes, the output columns and the filter fields (key, label, type, allowed operators). Use it to check that a field such as a shipper or a port really exists before filtering. If a requested field is not listed, say so and offer the listed ones.",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({ panelId: id }).strict(),
    handler: async (context, raw) => {
      const described = await describe(context.userId, context.organizationId, (raw as { panelId: string }).panelId);
      return {
        panelId: described.panelId, name: text(described.name),
        components: described.components.map((component) => ({ type: component.type, title: text(component.title) })).filter((component) => component.title).slice(0, 40),
        dataSets: described.bindings.map((binding) => ({
          name: binding.name, outputs: binding.outputs, paged: binding.paged,
          filters: binding.filters.map((filter) => ({ key: filter.key, label: text(filter.displayName), type: filter.type, operators: filter.operators })),
        })),
      };
    },
  },
  {
    name: "views.values.search",
    description: "Find the real values of a filter field (consignees, ports, countries, carriers...) with record counts, optionally narrowed by text. Use it to resolve a name the user typed to its exact spelling before filtering, and to detect ambiguity (several matches).",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({ panelId: id, dataSet: z.string().min(1).max(64).describe("Data set name from views.panel.describe"), field: z.string().min(1).max(128), search: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(MAX_ROWS).optional() }).strict(),
    handler: async (context, raw) => {
      const input = raw as { panelId: string; dataSet: string; field: string; search?: string; limit?: number };
      const described = await describe(context.userId, context.organizationId, input.panelId);
      const binding = bindingNamed(described, input.dataSet);
      const definition = definitionOf(binding, input.field);
      const result = await northAnalyticsBindings.facets(context.userId, context.organizationId, input.panelId, binding.id, {
        fieldId: definition.fieldId, filters: [], limit: input.limit ?? 10, ...(input.search ? { search: input.search } : {}),
      });
      return { field: input.field, matches: result.total, values: result.values.slice(0, input.limit ?? 10), moreAvailable: result.truncated };
    },
  },
  {
    name: "views.panel.query",
    description: "Run a query on one data set of a published dashboard with optional filters, sort and text search, and return the real rows (max 25) with the total count. Use it to answer questions with numbers and to list records. Values come from the user's authorized data only.",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({
      panelId: id, dataSet: z.string().min(1).max(64), filters: z.array(filterInput).max(10).optional(),
      sortBy: z.string().min(1).max(128).optional().describe("One of the data set outputs"), direction: z.enum(["ASC", "DESC"]).optional(),
      search: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(MAX_ROWS).optional(), offset: z.number().int().min(0).max(10_000).optional(),
    }).strict(),
    handler: async (context, raw) => {
      const input = raw as { panelId: string; dataSet: string; filters?: FilterInput[]; sortBy?: string; direction?: "ASC" | "DESC"; search?: string; limit?: number; offset?: number };
      const described = await describe(context.userId, context.organizationId, input.panelId);
      const binding = bindingNamed(described, input.dataSet);
      if (input.sortBy && !binding.outputs.includes(input.sortBy)) fail(422, "AI_SORT_NOT_AVAILABLE", `Sort by one of: ${binding.outputs.join(", ")}`);
      const result = await northAnalyticsBindings.results(context.userId, context.organizationId, input.panelId, binding.id, filtersFor(binding, input.filters), {
        ...(input.sortBy ? { sort: { key: input.sortBy, direction: input.direction ?? "DESC" } } : {}),
        ...(input.search ? { search: input.search } : {}), limit: input.limit ?? 10, ...(input.offset ? { offset: input.offset } : {}),
      });
      return { dataSet: binding.name, columns: result.columns.map((column) => column.key), rows: clip(result.rows as Array<Record<string, unknown>>), rowCount: result.rowCount, totalRows: result.totalRows ?? null };
    },
  },
  {
    name: "views.apply_filters",
    description: "Open a dashboard in NORTH and apply filters to it so the user sees the result on screen. Validates every field against the dashboard, then reports how many rows match. Use after the filter values are confirmed (views.values.search). Set replace=false to add to filters already applied.",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({ panelId: id, filters: z.array(filterInput).min(1).max(10), replace: z.boolean().optional() }).strict(),
    handler: async (context, raw) => {
      const input = raw as { panelId: string; filters: FilterInput[]; replace?: boolean };
      const described = await describe(context.userId, context.organizationId, input.panelId);
      const primary = primaryBinding(described);
      if (!primary) fail(422, "AI_PANEL_HAS_NO_DATA", "This dashboard has no data the user can query");
      const queryFilters = input.filters.flatMap((item) => {
        // The field must be filterable on at least one data set of the panel; the check binding is the one that owns it.
        const owner = described.bindings.find((binding) => binding.filters.some((filter) => filter.key === item.field)) ?? primary;
        return toQueryFilters(owner, item);
      });
      const count = await northAnalyticsBindings.results(context.userId, context.organizationId, input.panelId, primary.id, queryFilters.filter((filter) => primary.filters.some((allowed) => allowed.fieldId === filter.fieldId)), { limit: 1 });
      const ui: AIUiDirective = { type: "apply_filters", panelId: input.panelId, replace: input.replace !== false, filters: input.filters.map((item) => ({
        fieldKey: item.field, ...(item.values ? { values: item.values } : {}), ...(item.contains ? { text: item.contains } : {}), ...(item.from ? { from: item.from } : {}), ...(item.to ? { to: item.to } : {}),
      })) };
      return { applied: true, panel: text(described.name), filters: input.filters.map((item) => ({ field: item.field, values: item.values, contains: item.contains, from: item.from, to: item.to })), matchingRows: count.totalRows ?? count.rowCount, countedOn: primary.name, ui };
    },
  },
  {
    name: "views.clear_filters",
    description: "Remove every filter currently applied on a dashboard open in NORTH.",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({ panelId: id }).strict(),
    handler: async (context, raw) => {
      const { panelId } = raw as { panelId: string };
      const described = await describe(context.userId, context.organizationId, panelId);
      const ui: AIUiDirective = { type: "clear_filters", panelId };
      return { cleared: true, panel: text(described.name), ui };
    },
  },
  {
    name: "views.open_panel",
    description: "Open a published dashboard in NORTH for the user.",
    application: "north", risk: "read", requiredPermissions: ["organization.read"],
    input: z.object({ panelId: id }).strict(),
    handler: async (context, raw) => {
      const { panelId } = raw as { panelId: string };
      const described = await describe(context.userId, context.organizationId, panelId);
      const ui: AIUiDirective = { type: "open_panel", panelId };
      return { opened: true, panel: text(described.name), ui };
    },
  },

  // ── Administrative actions: proposed by the assistant, executed ONLY after the user confirms, re-authorized then ────────
  {
    name: "views.category.create",
    description: "Propose creating a new category in the organization's navigation. Nothing changes until the user confirms the action card. Requires permission to create categories.",
    application: "north", risk: "mutation", requiredPermissions: ["organization.read"],
    input: z.object({ name: z.string().trim().min(1).max(120), slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional() }).strict(),
    summarize: (input) => `Create category "${(input as { name: string }).name}"`,
    precheck: async (context) => {
      const allowed = await transaction((tx) => hasNorthCapability(tx, context.userId, "north.category.create", { organizationId: context.organizationId, scope: "ORGANIZATION" }));
      if (!allowed) fail(403, "AI_PERMISSION_DENIED", "The user is not allowed to create categories");
    },
    handler: async (context, raw) => {
      const input = raw as { name: string; slug?: string };
      const created = await northTaxonomy.createCategory(context.userId, context.organizationId, { name: { es: input.name, en: input.name }, ...(input.slug ? { slug: input.slug } : {}) });
      return { created: "category", id: created.id, slug: created.slug };
    },
  },
  {
    name: "views.subcategory.create",
    description: "Propose creating a subcategory inside an existing category (use the categorySlug from views.navigation.list or the user's words). Nothing changes until the user confirms the action card.",
    application: "north", risk: "mutation", requiredPermissions: ["organization.read"],
    input: z.object({ categorySlug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), name: z.string().trim().min(1).max(120), slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional() }).strict(),
    summarize: (input) => { const value = input as { categorySlug: string; name: string }; return `Create subcategory "${value.name}" in "${value.categorySlug}"`; },
    precheck: async (context, raw) => {
      const input = raw as { categorySlug: string };
      const category = await transaction((tx) => tx.northCategory.findFirst({ where: { organizationId: context.organizationId, slug: input.categorySlug, status: "ACTIVE" }, select: { id: true } }));
      if (!category) fail(422, "AI_CATEGORY_UNKNOWN", `There is no category "${input.categorySlug}"`);
      const allowed = await transaction((tx) => hasNorthCapability(tx, context.userId, "north.subcategory.create", { organizationId: context.organizationId, scope: "CATEGORY", categoryId: category.id }));
      if (!allowed) fail(403, "AI_PERMISSION_DENIED", "The user is not allowed to create subcategories here");
    },
    handler: async (context, raw) => {
      const input = raw as { categorySlug: string; name: string; slug?: string };
      const category = await transaction((tx) => tx.northCategory.findFirst({ where: { organizationId: context.organizationId, slug: input.categorySlug, status: "ACTIVE" }, select: { id: true } }));
      if (!category) fail(422, "AI_CATEGORY_UNKNOWN", `There is no category "${input.categorySlug}"`);
      const created = await northTaxonomy.createSubcategory(context.userId, context.organizationId, category.id, { name: { es: input.name, en: input.name }, ...(input.slug ? { slug: input.slug } : {}) });
      return { created: "subcategory", id: created.id, slug: created.slug };
    },
  },
];
