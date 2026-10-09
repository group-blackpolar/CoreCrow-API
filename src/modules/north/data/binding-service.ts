import type { Prisma } from "../../../lib/database.js";
import { fail } from "../../../shared/errors.js";
import { transaction, type Transaction } from "../../../shared/transaction.js";
import { auditRepository as audit } from "../../audit/repository.js";
import { hasNorthCapability } from "../authorization.js";
import { northPanelAudienceAllows } from "../audience.js";
import type { NorthPanelDocument } from "../content-schema.js";
import { authorizeDataset } from "./authorization.js";
import { allowedBindingFilterSchema, datasetQuerySchema, type AllowedBindingFilter, type DatasetQuery, type DatasetQueryFilter } from "./query-contract.js";
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
  results(userId: string, organizationId: string, panelId: string, bindingId: string, runtimeFilters: DatasetQueryFilter[]) {
    return transaction(async (tx) => {
      const { binding, query, allowed } = await authorizedPublishedBinding(tx, userId, organizationId, panelId, bindingId, runtimeFilters);
      const effective = { ...query, filters: [...(query.filters ?? []), ...runtimeFilters] } as DatasetQuery;
      if ((effective.filters?.length ?? 0) > 10) fail(422, "BINDING_FILTER_LIMIT_EXCEEDED", "Binding filters exceed the maximum of 10");
      const result = await executeDatasetQuery(tx, organizationId, binding.datasetId, effective);
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
      return { bindingId, filterDefinitions, ...result };
    });
  },
  facets(userId: string, organizationId: string, panelId: string, bindingId: string, input: { fieldId: string; search?: string; filters: DatasetQueryFilter[]; limit: number }) {
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
      const result = await executeDatasetQuery(tx, organizationId, binding.datasetId, {
        mode: "AGGREGATE", groupBy: [input.fieldId], measures: [{ operation: "COUNT", alias: "count" }],
        filters, orderBy: [{ key: "count", direction: "DESC" }], limit,
      });
      const values = result.rows.map((row) => ({ value: (row[input.fieldId] ?? null) as string | number | boolean | null, count: Number(row.count) }));
      return { bindingId, fieldId: input.fieldId, values, truncated: values.length >= limit, executedAt: result.executedAt };
    });
  },
};
