import type { Prisma } from "../../../lib/database.js";
import { fail } from "../../../shared/errors.js";
import { transaction, type Transaction } from "../../../shared/transaction.js";
import { auditRepository as audit } from "../../audit/repository.js";
import { hasNorthCapability } from "../authorization.js";
import { northPanelAudienceAllows } from "../audience.js";
import type { NorthPanelDocument } from "../content-schema.js";
import { authorizeDataset } from "./authorization.js";
import { allowedBindingFilterSchema, datasetQuerySchema, type AllowedBindingFilter, type BindingRuntimeOptions, type DatasetQuery, type DatasetQueryFilter } from "./query-contract.js";
import { previousPeriod, selectedPeriod, withPeriod } from "./period.js";
import { executeDatasetQuery } from "./query-service.js";

type BindingInput = { name: string; datasetId: string; query: DatasetQuery; allowedFilters?: AllowedBindingFilter[] };

function target(panel: { id: string; organizationId: string; subcategoryId: string; subcategory: { categoryId: string } }) {
  return { organizationId: panel.organizationId, scope: "PANEL" as const, categoryId: panel.subcategory.categoryId, subcategoryId: panel.subcategoryId, panelId: panel.id };
}

async function panelForManagement(tx: Transaction, userId: string, organizationId: string, panelId: string) {
  const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
  if (!membership) fail(404, "NOT_FOUND", "Panel not found");
  const panel = await tx.northPanel.findFirst({ where: { id: panelId, organizationId }, include: { subcategory: true } });
  if (!panel) fail(404, "NOT_FOUND", "Panel not found");
  if (!(await hasNorthCapability(tx, userId, "north.panel.update", target(panel)))) fail(403, "FORBIDDEN", "Permission denied");
  return panel;
}

async function validateAllowedFilters(tx: Transaction, organizationId: string, datasetId: string, allowed: AllowedBindingFilter[]) {
  const parsed = allowed.map((item) => allowedBindingFilterSchema.parse(item));
  if (new Set(parsed.map((item) => item.fieldId)).size !== parsed.length)
    fail(422, "BINDING_FILTER_INVALID", "Allowed filter fields must be unique");
  if (!parsed.length) return parsed;
  const dataset = await tx.northDataset.findFirst({
    where: { id: datasetId, organizationId, status: "ACTIVE" },
    include: { activeRevision: { include: { schemaVersion: { include: { fields: true } } } } },
  });
  if (!dataset?.activeRevision) fail(409, "DATASET_REVISION_NOT_ACTIVE", "Dataset has no active revision");
  const activeFields = new Set(dataset.activeRevision.schemaVersion.fields.filter((field) => field.status === "ACTIVE").map((field) => field.datasetFieldId));
  if (parsed.some((item) => !activeFields.has(item.fieldId)))
    fail(422, "BINDING_FILTER_INVALID", "Allowed filters must reference fields in the active dataset schema");
  return parsed;
}

/**
 * Dashboards fan out one request per component and re-ask on every filter tweak. Identical requests inside a few seconds
 * are served from memory. Authorization has ALREADY run for this caller when a lookup happens, and the key carries the
 * tenant, panel, binding, caller and the dataset's active revision, so a re-import or another identity can never read it.
 */
const RESULT_TTL_MS = 20_000;
const RESULT_CACHE_LIMIT = 300;
const resultCache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string): T | undefined {
  const hit = resultCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > RESULT_TTL_MS) { resultCache.delete(key); return undefined; }
  return hit.value as T;
}
function remember(key: string, value: unknown) {
  if (resultCache.size >= RESULT_CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value as string);
  resultCache.set(key, { at: Date.now(), value });
}

const outputKeys = (query: DatasetQuery) => query.mode === "ROWS" ? query.fields : [...(query.groupBy ?? []), ...query.measures.map((measure) => measure.alias)];

/** Declarations that only make sense against the dataset schema: the comparison date and the searchable text fields. */
async function validateQueryDeclarations(tx: Transaction, organizationId: string, datasetId: string, query: DatasetQuery, allowed: AllowedBindingFilter[]) {
  if (!query.compareBy && !query.searchFieldIds) return;
  const dataset = await tx.northDataset.findFirst({
    where: { id: datasetId, organizationId, status: "ACTIVE" },
    include: { activeRevision: { include: { schemaVersion: { include: { fields: true } } } } },
  });
  const fields = new Map((dataset?.activeRevision?.schemaVersion.fields ?? []).filter((field) => field.status === "ACTIVE").map((field) => [field.datasetFieldId, field]));
  if (query.compareBy) {
    const field = fields.get(query.compareBy);
    if (!field || !["DATE", "DATETIME"].includes(field.canonicalType) || !allowed.some((item) => item.fieldId === query.compareBy))
      fail(422, "BINDING_COMPARE_INVALID", "compareBy must be an allowed filter on a date field of the active schema");
  }
  if (query.searchFieldIds?.some((id) => fields.get(id)?.canonicalType !== "TEXT"))
    fail(422, "BINDING_SEARCH_INVALID", "searchFieldIds must be text fields of the active schema");
}

function referenced(document: NorthPanelDocument, binding: { id: string; datasetId: string }) {
  return document.sections.some((section) => section.components.some((component) =>
    Object.values(component.bindings).some((reference) =>
      reference.sourceType === "dataset" && reference.sourceId === binding.id && reference.datasetId === binding.datasetId,
    ),
  ));
}

function bindingView(binding: { id: string; organizationId: string; panelId: string; datasetId: string; name: string; query: Prisma.JsonValue; allowedFilters: Prisma.JsonValue; createdBy: string; createdAt: Date; updatedAt: Date }) {
  return { ...binding, query: datasetQuerySchema.parse(binding.query), allowedFilters: allowedBindingFilterSchema.array().parse(binding.allowedFilters) };
}

/** Shared by results and facets: a published, audience-authorized panel that references this binding, plus the binding's
 *  runtime-filter allowlist. Every failure is the same generic 404/403 so nothing about other tenants or panels leaks. */
async function authorizedPublishedBinding(tx: Transaction, userId: string, organizationId: string, panelId: string, bindingId: string, runtimeFilters: DatasetQueryFilter[]) {
      const panel = await tx.northPanel.findFirst({
        where: { id: panelId, organizationId, status: "PUBLISHED" },
        include: { subcategory: true, publishedRevision: true, audienceRoles: true, audienceGroups: true, audiencePermissions: true, audienceMemberships: true },
      });
      if (!panel?.publishedRevision || panel.resourceKind !== "CONTENT") fail(404, "NOT_FOUND", "Published panel not found");
      const panelTarget = target(panel);
      if (!(await hasNorthCapability(tx, userId, "north.panel.read", panelTarget)) || !(await hasNorthCapability(tx, userId, "north.content.read", panelTarget)))
        fail(404, "NOT_FOUND", "Published panel not found");
      if (panel.accessPolicyMode === "ACL_V1") fail(403, "FORBIDDEN", "Permission denied");
      if (!(await northPanelAudienceAllows(tx, userId, panel, panel.subcategory.categoryId))) fail(404, "NOT_FOUND", "Published panel not found");
      const binding = await tx.northAnalyticsBinding.findFirst({ where: { id: bindingId, organizationId, panelId } });
      if (!binding || !referenced(panel.publishedRevision.document as unknown as NorthPanelDocument, binding)) fail(404, "NOT_FOUND", "Binding not found");
      await authorizeDataset(tx, userId, organizationId, binding.datasetId, "north.data.query");
      const query = datasetQuerySchema.parse(binding.query);
      const allowed = allowedBindingFilterSchema.array().parse(binding.allowedFilters);
      const policy = new Map(allowed.map((item) => [item.fieldId, new Set(item.operators)]));
      if (runtimeFilters.length > 10 || runtimeFilters.some((item) => !policy.get(item.fieldId)?.has(item.operator)))
        fail(422, "BINDING_FILTER_NOT_ALLOWED", "A runtime filter is not allowed by this binding");
      return { binding, query, allowed };
}

export const northAnalyticsBindings = {
  list(userId: string, organizationId: string, panelId: string) {
    return transaction(async (tx) => {
      await panelForManagement(tx, userId, organizationId, panelId);
      return (await tx.northAnalyticsBinding.findMany({ where: { organizationId, panelId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(bindingView);
    });
  },
  create(userId: string, organizationId: string, panelId: string, input: BindingInput) {
    return transaction(async (tx) => {
      await panelForManagement(tx, userId, organizationId, panelId);
      await authorizeDataset(tx, userId, organizationId, input.datasetId, "north.data.query");
      const query = datasetQuerySchema.parse(input.query);
      const allowedFilters = await validateAllowedFilters(tx, organizationId, input.datasetId, input.allowedFilters ?? []);
      await validateQueryDeclarations(tx, organizationId, input.datasetId, query, allowedFilters);
      await executeDatasetQuery(tx, organizationId, input.datasetId, query);
      const binding = await tx.northAnalyticsBinding.create({ data: { organizationId, panelId, datasetId: input.datasetId, name: input.name, query, allowedFilters, createdBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "ANALYTICS_BINDING_CREATED", targetType: "NorthAnalyticsBinding", targetId: binding.id, metadata: { panelId, datasetId: input.datasetId } });
      return bindingView(binding);
    });
  },
  update(userId: string, organizationId: string, panelId: string, bindingId: string, input: BindingInput) {
    return transaction(async (tx) => {
      await panelForManagement(tx, userId, organizationId, panelId);
      const current = await tx.northAnalyticsBinding.findFirst({ where: { id: bindingId, organizationId, panelId } });
      if (!current) fail(404, "NOT_FOUND", "Binding not found");
      await authorizeDataset(tx, userId, organizationId, input.datasetId, "north.data.query");
      const query = datasetQuerySchema.parse(input.query);
      const allowedFilters = await validateAllowedFilters(tx, organizationId, input.datasetId, input.allowedFilters ?? []);
      await validateQueryDeclarations(tx, organizationId, input.datasetId, query, allowedFilters);
      await executeDatasetQuery(tx, organizationId, input.datasetId, query);
      const binding = await tx.northAnalyticsBinding.update({
        where: { id_panelId_organizationId: { id: bindingId, panelId, organizationId } },
        data: { datasetId: input.datasetId, name: input.name, query, allowedFilters },
      });
      await audit.append(tx, { actorId: userId, organizationId, action: "ANALYTICS_BINDING_UPDATED", targetType: "NorthAnalyticsBinding", targetId: binding.id, metadata: { panelId, datasetId: input.datasetId } });
      return bindingView(binding);
    });
  },
  async validateReference(organizationId: string, reference: { sourceType: "metric" | "dataset"; sourceId: string; datasetId?: string }, actorId: string, tx: Transaction | undefined, panelId?: string) {
    if (reference.sourceType !== "dataset" || !reference.datasetId || !panelId || !tx) return false;
    const binding = await tx.northAnalyticsBinding.findFirst({ where: { id: reference.sourceId, organizationId, panelId, datasetId: reference.datasetId } });
    if (!binding) return false;
    try { await authorizeDataset(tx, actorId, organizationId, binding.datasetId, "north.data.query"); } catch { return false; }
    return true;
  },
  results(userId: string, organizationId: string, panelId: string, bindingId: string, runtimeFilters: DatasetQueryFilter[], options: BindingRuntimeOptions = {}) {
    return transaction(async (tx) => {
      const { binding, query, allowed } = await authorizedPublishedBinding(tx, userId, organizationId, panelId, bindingId, runtimeFilters);
      const revision = (await tx.northDataset.findFirst({ where: { id: binding.datasetId, organizationId }, select: { activeRevisionId: true } }))?.activeRevisionId ?? "none";
      const { fresh, ...requested } = options;
      const cacheKey = JSON.stringify([organizationId, panelId, bindingId, userId, revision, runtimeFilters, requested]);
      const hit = fresh ? undefined : cached<Awaited<ReturnType<typeof executeDatasetQuery>> & { filterDefinitions: unknown; comparison?: unknown; bindingId: string }>(cacheKey);
      if (hit) return hit;
      const withOptions = (filters: DatasetQueryFilter[]): DatasetQuery => {
        const effective = { ...query, filters: [...(query.filters ?? []), ...filters] } as DatasetQuery;
        if ((effective.filters?.length ?? 0) > 10) fail(422, "BINDING_FILTER_LIMIT_EXCEEDED", "Binding filters exceed the maximum of 10");
        if (options.sort) {
          if (!outputKeys(query).includes(options.sort.key)) fail(422, "BINDING_SORT_NOT_ALLOWED", "Sorting is only available on the binding's own output columns");
          if (effective.mode === "ROWS") effective.orderBy = [{ fieldId: options.sort.key, direction: options.sort.direction }];
          else effective.orderBy = [{ key: options.sort.key, direction: options.sort.direction }];
        }
        if (options.offset !== undefined) effective.offset = options.offset;
        // A reader can only shrink the page: the binding's own limit is the ceiling.
        if (options.limit !== undefined) effective.limit = Math.min(options.limit, query.limit ?? 100);
        if (options.search) {
          if (!query.searchFieldIds) fail(422, "BINDING_SEARCH_NOT_ALLOWED", "This binding does not declare searchable fields");
          effective.search = { fieldIds: query.searchFieldIds, text: options.search };
        }
        return effective;
      };
      const result = await executeDatasetQuery(tx, organizationId, binding.datasetId, withOptions(runtimeFilters));
      let comparison: { period: { from: string; to: string }; previousPeriod: { from: string; to: string }; rows: typeof result.rows } | undefined;
      if (options.compare && query.compareBy) {
        const period = selectedPeriod(runtimeFilters, query.compareBy);
        const previous = period && previousPeriod(period.from, period.to);
        if (period && previous) {
          const earlier = await executeDatasetQuery(tx, organizationId, binding.datasetId, withOptions(withPeriod(runtimeFilters, query.compareBy, previous)));
          comparison = { period, previousPeriod: previous, rows: earlier.rows };
        }
      }
      const definitions = allowed.length
        ? await tx.northDatasetField.findMany({
          where: { organizationId, datasetId: binding.datasetId, id: { in: allowed.map((item) => item.fieldId) } },
          select: { id: true, key: true, displayName: true, canonicalType: true },
        })
        : [];
      const byId = new Map(definitions.map((field) => [field.id, field]));
      const filterDefinitions = allowed.map((policy) => {
        const field = byId.get(policy.fieldId);
        if (!field) fail(422, "BINDING_FILTER_INVALID", "An allowed filter field no longer exists");
        return { fieldId: field.id, key: field.key, displayName: field.displayName, type: field.canonicalType, operators: policy.operators };
      });
      const payload = { bindingId, filterDefinitions, ...result, ...(comparison ? { comparison } : {}) };
      remember(cacheKey, payload);
      return payload;
    });
  },
  facets(userId: string, organizationId: string, panelId: string, bindingId: string, input: { fieldId: string; search?: string; filters: DatasetQueryFilter[]; limit: number; offset?: number; granularity?: "DAY" | "MONTH" | "QUARTER" | "YEAR" }) {
    return transaction(async (tx) => {
      const { binding, query, allowed } = await authorizedPublishedBinding(tx, userId, organizationId, panelId, bindingId, input.filters);
      if (!allowed.some((item) => item.fieldId === input.fieldId)) fail(422, "BINDING_FILTER_NOT_ALLOWED", "Facet values are only available for fields this binding allows as filters");
      // Standard faceting: the facet's own selection is excluded so the user can still see (and add) sibling values;
      // the binding's base filters and every OTHER runtime filter always apply, so counts never reveal excluded rows.
      const others = input.filters.filter((item) => item.fieldId !== input.fieldId);
      const search = input.search?.trim();
      const filters: DatasetQueryFilter[] = [...(query.filters ?? []), ...others, ...(search ? [{ fieldId: input.fieldId, operator: "CONTAINS" as const, value: search }] : [])];
      if (filters.length > 10) fail(422, "BINDING_FILTER_LIMIT_EXCEEDED", "Binding filters exceed the maximum of 10");
      const limit = Math.min(input.limit, 100);
      // Date buckets (month/year) list the periods that actually hold data, newest first; they ignore text search.
      const bucketed = input.granularity ? { granularity: { [input.fieldId]: input.granularity } } : {};
      const result = await executeDatasetQuery(tx, organizationId, binding.datasetId, {
        mode: "AGGREGATE", groupBy: [input.fieldId], ...bucketed, measures: [{ operation: "COUNT", alias: "count" }],
        filters: input.granularity ? filters.filter((item) => !(item.fieldId === input.fieldId && item.operator === "CONTAINS")) : filters,
        orderBy: input.granularity ? [{ key: input.fieldId, direction: "DESC" }] : [{ key: "count", direction: "DESC" }], limit, offset: input.offset ?? 0, includeTotal: true,
      });
      const values = result.rows.map((row) => ({ value: (row[input.fieldId] ?? null) as string | number | boolean | null, count: Number(row.count) }));
      const total = result.totalRows ?? values.length;
      return { bindingId, fieldId: input.fieldId, values, truncated: (input.offset ?? 0) + values.length < total, total, executedAt: result.executedAt };
    });
  },
};
