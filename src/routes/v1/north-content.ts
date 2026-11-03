import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../../contracts/route.js";
import * as s from "../../contracts/schemas.js";
import { storageSummary } from "../../modules/north/storage-usage.js";
import { northCapabilities } from "../../modules/authorization/policy.js";
import { northPermissions, northTaxonomy } from "../../modules/north/service.js";
import { northContent } from "../../modules/north/content-service.js";
import { northPanelDocumentInput } from "../../modules/north/content-schema.js";
import { northAssets } from "../../modules/north/asset-service.js";
import { northTemplates } from "../../modules/north/template-service.js";
import { northTemplateCreateInput, northTemplateSnapshotInput } from "../../modules/north/template-schema.js";
import { northSearch } from "../../modules/north/search-service.js";
import { northAnalyticsBindings } from "../../modules/north/data/binding-service.js";
import { northShowcase } from "../../modules/north/showcase-service.js";
import { allowedBindingFilterSchema, bindingRuntimeOptions, datasetQueryFilter, datasetQuerySchema } from "../../modules/north/data/query-contract.js";

export async function northContentRoutes(app: FastifyInstance) {
  const panelBindingParams = s.orgParams.extend({ panelId: s.id });
  const panelBindingDetailParams = panelBindingParams.extend({ bindingId: s.id });
  const bindingInput = z.object({
    name: z.string().trim().min(1).max(100),
    datasetId: s.id,
    query: datasetQuerySchema,
    allowedFilters: z.array(allowedBindingFilterSchema).max(10).optional(),
  }).strict();
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/analytics-bindings", tag: "NORTH analytics",
    summary: "List authoritative analytics bindings owned by one authorized panel", params: panelBindingParams,
    response: z.array(s.northAnalyticsBinding),
    run: ({ user, params }) => northAnalyticsBindings.list(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/analytics-bindings", tag: "NORTH analytics",
    summary: "Create an audited panel-owned binding with a bounded declarative dataset query", params: panelBindingParams,
    body: bindingInput, response: s.northAnalyticsBinding, status: 201,
    run: ({ user, params, body }) => northAnalyticsBindings.create(user.id, params.organizationId, params.panelId, body),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/panels/:panelId/analytics-bindings/:bindingId", tag: "NORTH analytics",
    summary: "Replace an audited panel-owned binding after tenant and dataset authorization", params: panelBindingDetailParams,
    body: bindingInput, response: s.northAnalyticsBinding,
    run: ({ user, params, body }) => northAnalyticsBindings.update(user.id, params.organizationId, params.panelId, params.bindingId, body),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/panels/:panelId/analytics-bindings/:bindingId", tag: "NORTH analytics",
    summary: "Delete a data binding that no draft or published version of the view uses", params: panelBindingDetailParams, response: z.null(),
    run: ({ user, params }) => northAnalyticsBindings.remove(user.id, params.organizationId, params.panelId, params.bindingId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/analytics-bindings/:bindingId/results", tag: "NORTH analytics",
    summary: "Resolve only a binding referenced by this exact published panel and apply allowlisted runtime filters", params: panelBindingDetailParams,
    body: z.object({ filters: z.array(datasetQueryFilter).max(10).default([]) }).merge(bindingRuntimeOptions).strict(),
    response: s.northAnalyticsBindingResult, rateLimit: 300,
    run: ({ user, params, body }) => { const { filters, ...options } = body; return northAnalyticsBindings.results(user.id, params.organizationId, params.panelId, params.bindingId, filters, options); },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/analytics-bindings/:bindingId/facets", tag: "NORTH analytics",
    summary: "List the distinct values (with counts) of one allowlisted binding filter field for a published panel; the field's own selection is excluded from the counts",
    params: panelBindingDetailParams,
    body: z.object({
      fieldId: s.id, search: z.string().trim().max(200).optional(),
      filters: z.array(datasetQueryFilter).max(10).default([]), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(100_000).default(0),
      granularity: z.enum(["DAY", "MONTH", "QUARTER", "YEAR"]).optional(),
    }).strict(),
    response: s.northAnalyticsFacetResult, rateLimit: 180,
    run: ({ user, params, body }) => northAnalyticsBindings.facets(user.id, params.organizationId, params.panelId, params.bindingId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/assets/uploads", tag: "NORTH assets",
    summary: "Reserve quota and request a checksum-bound signed asset upload", params: s.orgParams,
    body: z.object({
      filename: z.string().trim().min(1).max(255),
      mime: z.string().trim().min(1).max(127),
      size: z.number().int().min(1),
      checksum: z.string().regex(/^[0-9a-fA-F]{64}$/),
    }).strict(),
    response: z.object({ asset: s.northAsset, upload: s.northSignedObjectRequest }), status: 201,
    run: ({ user, params, body }) => northAssets.requestUpload(user.id, params.organizationId, body),
  });
  const assetParams = s.orgParams.extend({ assetId: s.id });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/assets/:assetId/confirm", tag: "NORTH assets",
    summary: "Inspect, validate, scan, and atomically make an uploaded asset ready", params: assetParams,
    response: s.northAsset,
    run: ({ user, params }) => northAssets.confirm(user.id, params.organizationId, params.assetId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/assets/:assetId/read", tag: "NORTH assets",
    summary: "Re-authorize and issue a short-lived signed read for a ready asset", params: assetParams,
    response: z.object({ asset: s.northAsset, download: s.northSignedObjectRequest }),
    run: ({ user, params }) => northAssets.signedRead(user.id, params.organizationId, params.assetId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/assets/:assetId", tag: "NORTH assets",
    summary: "Soft-delete an asset, release quota, and request physical object deletion", params: assetParams,
    response: z.null(),
    run: ({ user, params }) => northAssets.delete(user.id, params.organizationId, params.assetId),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/storage",
    tag: "Multi-tenancy",
    summary: "Read the organization's storage usage against its limit (assets and dataset import files)",
    params: s.orgParams,
    response: z.object({
      limitBytes: z.string(), usedBytes: z.string(), assetBytes: z.string(), reservedBytes: z.string(), importBytes: z.string(),
      assetCount: z.number().int().nonnegative(), importCount: z.number().int().nonnegative(),
      byCategory: z.array(z.object({ category: z.enum(["image", "video", "document", "other"]), bytes: z.string(), count: z.number().int().nonnegative() })),
    }),
    run: ({ user, params }) => storageSummary(user.id, params.organizationId),
  });
  const northUpdateMetadataBase = s.northMetadataInput.partial();
  const northUpdateMetadata = northUpdateMetadataBase.refine((value) => Object.keys(value).length > 0);
  const categoryParams = s.orgParams.extend({ categoryId: s.id });
  const subcategoryParams = s.orgParams.extend({ subcategoryId: s.id });
  const panelParams = s.orgParams.extend({ panelId: s.id });
  const panelRevisionParams = panelParams.extend({ revisionId: s.id });
  const revisionSummary = z.object({
    id: s.id, panelId: s.id, revisionNumber: z.number().int().min(1), etag: z.string(),
    defaultLocale: z.string(), fallbackLocales: z.array(z.string()), message: z.string().nullable(),
    publishAt: s.date.nullable(), unpublishAt: s.date.nullable(), createdBy: s.id, createdAt: s.date,
  });
  const panelRevision = revisionSummary.extend({ document: northPanelDocumentInput });
  const ifMatch = (request: { headers: Record<string, unknown> }) => {
    const value = request.headers["if-match"];
    return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
  };
  const navigationPanel = z.object({ id: s.id, name: s.localizedText, icon: z.string().nullable(), slug: z.string(), status: s.northPanelStatus });
  const navigation = z.array(z.object({
    id: s.id, name: s.localizedText, icon: z.string().nullable(), color: z.string().nullable(), slug: z.string(),
    subcategories: z.array(z.object({ id: s.id, name: s.localizedText, icon: z.string().nullable(), slug: z.string(), panels: z.array(navigationPanel) })),
  }));
  const managementTree = z.array(s.northCategory.extend({
    subcategories: z.array(s.northSubcategory.extend({
      panels: z.array(s.northPanel),
    })),
  }));
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/report-access", tag: "NORTH taxonomy",
    summary: "Access state (ALLOWED, RESTRICTED, NOT_CONFIGURED) of up to 20 report categories for the caller, in one server-authorized request",
    params: s.orgParams,
    query: z.object({ categories: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}(,[a-z0-9][a-z0-9-]{0,63}){0,19}$/) }).strict(),
    response: z.array(z.object({
      slug: z.string(), state: z.enum(["ALLOWED", "RESTRICTED", "NOT_CONFIGURED"]),
      target: z.object({ categoryId: s.id, categorySlug: z.string(), subcategoryId: s.id, subcategorySlug: z.string(), panelSlug: z.string() }).nullable(),
    })),
    run: ({ user, params, query }) => northTaxonomy.reportAccess(user.id, params.organizationId, [...new Set(query.categories.split(","))]),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/navigation", tag: "NORTH taxonomy",
    summary: "Read compact server-authorized organization navigation", params: s.orgParams, response: navigation,
    run: ({ user, params }) => northTaxonomy.navigation(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/management-tree", tag: "NORTH taxonomy",
    summary: "Read complete tenant taxonomy metadata for authorized organization management", params: s.orgParams,
    response: managementTree,
    run: ({ user, params }) => northTaxonomy.managementTree(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/categories", tag: "NORTH taxonomy",
    summary: "Create an organization content category", params: s.orgParams,
    body: s.northMetadataInput.extend({ categoryClass: z.literal("CUSTOM").default("CUSTOM"), resourceKind: z.literal("CONTENT").default("CONTENT") }).strict(),
    response: s.northCategory, status: 201,
    run: ({ user, params, body }) => northTaxonomy.createCategory(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/categories/:categoryId", tag: "NORTH taxonomy",
    summary: "Update category metadata while preserving its stable ID", params: categoryParams, body: northUpdateMetadata,
    response: s.northCategory, run: ({ user, params, body }) => northTaxonomy.updateCategory(user.id, params.organizationId, params.categoryId, body),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/categories/:categoryId", tag: "NORTH taxonomy",
    summary: "Permanently delete a category with its subcategories and panels (datasets and assets are kept)", params: categoryParams, response: z.null(),
    run: ({ user, params }) => northTaxonomy.deleteCategory(user.id, params.organizationId, params.categoryId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/subcategories/:subcategoryId", tag: "NORTH taxonomy",
    summary: "Permanently delete a subcategory with its panels", params: subcategoryParams, response: z.null(),
    run: ({ user, params }) => northTaxonomy.deleteSubcategory(user.id, params.organizationId, params.subcategoryId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/panels/:panelId", tag: "NORTH taxonomy",
    summary: "Permanently delete a panel with its revisions and bindings", params: panelParams, response: z.null(),
    run: ({ user, params }) => northTaxonomy.deletePanel(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/categories/:categoryId/archive", tag: "NORTH taxonomy",
    summary: "Archive a content category", params: categoryParams, response: s.northCategory,
    run: ({ user, params }) => northTaxonomy.archiveCategory(user.id, params.organizationId, params.categoryId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/categories/:categoryId/subcategories", tag: "NORTH taxonomy",
    summary: "Create a subcategory", params: categoryParams,
    body: s.northMetadataInput.extend({ resourceKind: z.literal("CONTENT").default("CONTENT") }).strict(), response: s.northSubcategory, status: 201,
    run: ({ user, params, body }) => northTaxonomy.createSubcategory(user.id, params.organizationId, params.categoryId, body),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/subcategories/:subcategoryId", tag: "NORTH taxonomy",
    summary: "Update or move a same-tenant subcategory", params: subcategoryParams,
    body: northUpdateMetadataBase.extend({ categoryId: s.id.optional() }).refine((value) => Object.keys(value).length > 0), response: s.northSubcategory,
    run: ({ user, params, body }) => northTaxonomy.updateSubcategory(user.id, params.organizationId, params.subcategoryId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/subcategories/:subcategoryId/archive", tag: "NORTH taxonomy",
    summary: "Archive a content subcategory", params: subcategoryParams, response: s.northSubcategory,
    run: ({ user, params }) => northTaxonomy.archiveSubcategory(user.id, params.organizationId, params.subcategoryId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/subcategories/:subcategoryId/panels", tag: "NORTH taxonomy",
    summary: "Create panel metadata", params: subcategoryParams,
    body: s.northMetadataInput.extend({ resourceKind: z.literal("CONTENT").default("CONTENT"), audienceType: s.northAudienceType.default("ALL_MEMBERS") }).strict(), response: s.northPanel, status: 201,
    run: ({ user, params, body }) => northTaxonomy.createPanel(user.id, params.organizationId, params.subcategoryId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId", tag: "NORTH taxonomy",
    summary: "Read authorized panel metadata", params: panelParams, response: s.northPanel,
    run: ({ user, params }) => northTaxonomy.readPanel(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/panels/:panelId", tag: "NORTH taxonomy",
    summary: "Update or move same-tenant panel metadata", params: panelParams,
    body: northUpdateMetadataBase.extend({ subcategoryId: s.id.optional() }).refine((value) => Object.keys(value).length > 0), response: s.northPanel,
    run: ({ user, params, body }) => northTaxonomy.updatePanel(user.id, params.organizationId, params.panelId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/archive", tag: "NORTH taxonomy",
    summary: "Archive a content panel", params: panelParams, response: s.northPanel,
    run: ({ user, params }) => northTaxonomy.archivePanel(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/draft", tag: "NORTH content",
    summary: "Preview the current authorized panel draft", params: panelParams, response: panelRevision,
    run: async ({ user, params, reply }) => {
      const revision = await northContent.draft(user.id, params.organizationId, params.panelId);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/panels/:panelId/draft", tag: "NORTH content",
    summary: "Autosave a validated immutable draft revision using optimistic concurrency", params: panelParams,
    headers: { properties: { "if-match": { type: "string", description: "Strong ETag of the current draft; optional only when no draft exists" } } },
    body: z.object({ document: z.record(z.string(), z.unknown()), message: z.string().trim().max(500).optional(), publishAt: s.date.optional(), unpublishAt: s.date.optional() }).strict(),
    response: panelRevision,
    run: async ({ user, params, body, request, reply }) => {
      const revision = await northContent.saveDraft(user.id, params.organizationId, params.panelId, ifMatch(request), body);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/draft/validate", tag: "NORTH content",
    summary: "Validate the current draft before publishing (schema, references, data bindings, layout); read-only", params: panelParams,
    response: z.object({
      revisionId: s.id, revisionNumber: z.number().int().min(1), etag: z.string(), checkedAt: s.date, valid: z.boolean(),
      issues: z.array(z.object({ severity: z.enum(["error", "warning"]), code: z.string(), message: z.string(), sectionId: z.string().optional(), componentId: z.string().optional() }).strict()),
      dependencies: z.array(z.object({ kind: z.enum(["binding", "dataset"]), id: z.string(), status: z.enum(["ok", "missing", "unavailable", "forbidden"]), componentIds: z.array(z.string()) }).strict()),
    }).strict(),
    rateLimit: 60,
    run: ({ user, params }) => northContent.validateDraft(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/publish", tag: "NORTH content",
    summary: "Publish the exact current draft revision", params: panelParams, response: panelRevision,
    headers: { properties: { "if-match": { type: "string", description: "Strong ETag of the current draft" } }, required: ["if-match"] },
    run: async ({ user, params, request, reply }) => {
      const revision = await northContent.publish(user.id, params.organizationId, params.panelId, ifMatch(request));
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/revisions", tag: "NORTH content",
    summary: "List immutable panel revision history", params: panelParams, response: z.array(revisionSummary),
    run: ({ user, params }) => northContent.history(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/revisions/:revisionId", tag: "NORTH content",
    summary: "Read one immutable panel revision", params: panelRevisionParams, response: panelRevision,
    run: async ({ user, params, reply }) => {
      const revision = await northContent.revision(user.id, params.organizationId, params.panelId, params.revisionId);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/revisions/:revisionId/restore", tag: "NORTH content",
    summary: "Restore an immutable snapshot as a new draft revision", params: panelRevisionParams,
    headers: { properties: { "if-match": { type: "string", description: "Strong ETag of the current draft" } }, required: ["if-match"] },
    body: z.object({ message: z.string().trim().max(500).optional() }).strict(), response: panelRevision, status: 201,
    run: async ({ user, params, body, request, reply }) => {
      const revision = await northContent.restore(user.id, params.organizationId, params.panelId, params.revisionId, ifMatch(request), body.message);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/reorder", tag: "NORTH taxonomy",
    summary: "Transactionally reorder one complete sibling list", params: s.orgParams,
    body: z.object({ kind: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL"]), parentId: s.id.optional(), ids: z.array(s.id).max(100) }).strict(),
    response: z.object({ updated: z.number().int().nonnegative() }),
    run: ({ user, params, body }) => northTaxonomy.reorder(user.id, params.organizationId, body.kind, body.parentId, body.ids),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/clone", tag: "NORTH taxonomy",
    summary: "Clone content taxonomy with new stable IDs inside the same tenant", params: s.orgParams,
    body: z.object({ kind: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL"]), sourceId: s.id, destinationParentId: s.id.optional(), slug: z.string().trim().min(1).max(100) }).strict(),
    response: z.union([s.northCategory, s.northSubcategory, s.northPanel]), status: 201,
    run: ({ user, params, body }) => northTaxonomy.clone(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/panels/:panelId/audience", tag: "NORTH authorization",
    summary: "Replace a panel audience with same-tenant selectors", params: panelParams,
    body: z.object({ type: s.northAudienceType, roles: z.array(s.role).max(10).optional(), groupIds: z.array(s.id).max(100).optional(), capabilities: z.array(z.enum(northCapabilities)).max(100).optional(), membershipIds: z.array(s.id).max(100).optional() }).strict(),
    response: s.northPanel,
    run: ({ user, params, body }) => northTaxonomy.setAudience(user.id, params.organizationId, params.panelId, body),
  });
  const northAudience = z.object({
    type: s.northAudienceType,
    roles: z.array(s.role),
    groupIds: z.array(s.id),
    capabilities: z.array(z.enum(northCapabilities)),
    membershipIds: z.array(s.id),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/audience", tag: "NORTH authorization",
    summary: "Read the complete authorized selector set for a panel audience", params: panelParams,
    response: northAudience,
    run: ({ user, params }) => northTaxonomy.audience(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/home-panel", tag: "NORTH taxonomy",
    summary: "Select a published authorized organization home panel or system fallback", params: s.orgParams,
    body: z.object({ panelId: s.id.nullable() }).strict(), response: z.object({ homePanelId: s.id.nullable() }),
    run: ({ user, params, body }) => northTaxonomy.setHome(user.id, params.organizationId, body.panelId),
  });
  const northGrant = z.object({
    id: s.id, organizationId: s.id, capability: z.enum(northCapabilities), scope: s.northPermissionScope,
    role: s.role.optional(), groupId: s.id.optional(), membershipId: s.id.optional(),
    categoryId: s.id.nullable(), subcategoryId: s.id.nullable(), panelId: s.id.nullable(), createdAt: s.date,
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/permission-grants", tag: "NORTH authorization",
    summary: "List scoped role, group, and direct NORTH grants", params: s.orgParams,
    response: z.object({ roles: z.array(northGrant), groups: z.array(northGrant), memberships: z.array(northGrant) }),
    run: ({ user, params }) => northPermissions.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/permission-subjects", tag: "NORTH authorization",
    summary: "List tenant-scoped roles, groups, and labeled memberships for NORTH grant selection", params: s.orgParams,
    response: z.object({
      roles: z.array(s.role),
      groups: z.array(z.object({ id: s.id, name: s.name })),
      memberships: z.array(z.object({ id: s.id, userId: s.id, name: z.string().nullable(), role: s.role })),
    }),
    run: ({ user, params }) => northPermissions.subjects(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/role-data-access", tag: "NORTH authorization",
    summary: "Let a role run bounded queries on selected datasets (north.data.query grant plus dataset ACL) in one step", params: s.orgParams,
    body: z.object({ role: s.role, datasetIds: z.array(s.id).min(1).max(50) }).strict(),
    response: z.object({ role: s.role, capabilityGranted: z.boolean(), datasetIds: z.array(s.id), rulesCreated: z.number().int().nonnegative() }),
    run: ({ user, params, body }) => northPermissions.grantRoleDataAccess(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/permission-grants", tag: "NORTH authorization",
    summary: "Create a scoped additive grant with anti-escalation enforcement", params: s.orgParams,
    body: z.object({ subjectType: z.enum(["ROLE", "GROUP", "MEMBERSHIP"]), role: s.role.optional(), groupId: s.id.optional(), membershipId: s.id.optional(), capability: z.enum(northCapabilities), scope: s.northPermissionScope, resourceId: s.id.optional() }).strict(),
    response: northGrant, status: 201,
    run: ({ user, params, body }) => northPermissions.grant(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/north/permission-grants/:id", tag: "NORTH authorization",
    summary: "Revoke an authorized scoped NORTH grant", params: s.orgParams.extend({ id: s.id }), response: z.null(),
    run: ({ user, params }) => northPermissions.revoke(user.id, params.organizationId, params.id),
  });
  const northTemplate = z.object({
    id: s.id,
    slug: z.string(),
    name: s.localizedText,
    description: s.localizedText.nullable(),
    status: s.northResourceStatus,
    currentVersion: z.number().int().min(1),
    createdBy: s.id,
    createdAt: s.date,
    updatedAt: s.date,
  });
  const northTemplateDetail = northTemplate.extend({
    version: z.number().int().min(1),
    snapshot: northTemplateSnapshotInput,
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/templates", tag: "NORTH templates",
    summary: "List active global templates authorized for an organization", params: s.orgParams,
    response: z.array(northTemplate),
    run: ({ user, params }) => northTemplates.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/templates/:templateId", tag: "NORTH templates",
    summary: "Read an immutable global template version", params: s.orgParams.extend({ templateId: s.id }),
    query: z.object({ version: z.coerce.number().int().min(1).optional() }).strict(),
    response: northTemplateDetail,
    run: ({ user, params, query }) => northTemplates.read(user.id, params.organizationId, params.templateId, query.version),
  });
  contract(app, {
    method: "POST", url: "/platform/north/templates", tag: "NORTH templates",
    summary: "Create a versioned global template as an authorized platform administrator",
    body: northTemplateCreateInput, response: northTemplate, status: 201,
    run: ({ user, body }) => northTemplates.create(user.id, body),
  });
  contract(app, {
    method: "GET", url: "/platform/north/templates", tag: "NORTH templates",
    summary: "List global templates including archived entries for platform management",
    response: z.array(northTemplate),
    run: ({ user }) => northTemplates.platformList(user.id),
  });
  contract(app, {
    method: "PATCH", url: "/platform/north/templates/:templateId", tag: "NORTH templates",
    summary: "Update or archive global template metadata without mutating existing tenant copies",
    params: z.object({ templateId: s.id }).strict(),
    body: z.object({
      slug: z.string().trim().min(1).max(100).optional(),
      name: s.localizedText.optional(),
      description: s.localizedText.nullable().optional(),
      status: s.northResourceStatus.optional(),
    }).strict().refine((value) => Object.keys(value).length > 0),
    response: northTemplate,
    run: ({ user, params, body }) => northTemplates.update(user.id, params.templateId, body),
  });
  contract(app, {
    method: "POST", url: "/platform/north/templates/:templateId/versions", tag: "NORTH templates",
    summary: "Append an immutable version to a global template", params: z.object({ templateId: s.id }).strict(),
    body: z.object({ snapshot: northTemplateSnapshotInput }).strict(),
    response: z.object({ id: s.id, templateId: s.id, version: z.number().int().min(1), snapshot: northTemplateSnapshotInput, createdBy: s.id, createdAt: s.date }),
    status: 201,
    run: ({ user, params, body }) => northTemplates.createVersion(user.id, params.templateId, body.snapshot),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/templates/:templateId/apply", tag: "NORTH templates",
    summary: "Apply one immutable template version as an independent tenant-owned draft copy",
    params: s.orgParams.extend({ templateId: s.id }),
    body: z.object({ version: z.number().int().min(1).optional(), slug: z.string().trim().min(1).max(100).optional() }).strict(),
    response: s.northCategory, status: 201,
    run: ({ user, params, body }) => northTemplates.apply(user.id, params.organizationId, params.templateId, body),
  });
  const northSearchResult = z.object({
    id: s.id,
    resourceType: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL", "ASSET"]),
    name: s.localizedText,
    description: s.localizedText.nullable(),
    status: z.string(),
    categoryId: s.id.nullable(),
    subcategoryId: s.id.nullable(),
    panelId: s.id.nullable(),
    updatedAt: s.date,
    updatedBy: s.id.nullable(),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/search", tag: "NORTH search",
    summary: "Search only tenant-scoped resources authorized for the current principal", params: s.orgParams,
    query: z.object({
      query: z.string().trim().min(1).max(200),
      resourceType: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL", "ASSET"]).optional(),
      categoryId: s.id.optional(),
      status: z.enum(["ACTIVE", "DRAFT", "PUBLISHED", "ARCHIVED", "READY"]).optional(),
      updatedBy: s.id.optional(),
      updatedAfter: s.date.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict(),
    response: z.array(northSearchResult),
    run: ({ user, params, query }) => northSearch.run(user.id, params.organizationId, query),
  });
  contract(app, {
    method: "GET", url: "/content/resolve", tag: "NORTH content",
    summary: "Resolve one exact authorized published panel document without enumeration", query: z.object({ organizationSlug: z.string(), categorySlug: z.string(), subcategorySlug: z.string(), panelSlug: z.string(), locale: z.string().optional() }).strict(),
    response: z.object({
      organization: z.object({ name: s.name, slug: z.string() }),
      category: z.object({ id: s.id, name: s.localizedText, slug: z.string() }),
      subcategory: z.object({ id: s.id, name: s.localizedText, slug: z.string() }),
      panel: z.object({ id: s.id, name: s.localizedText, description: s.localizedText.nullable(), icon: z.string().nullable(), slug: z.string(), status: z.literal("PUBLISHED") }),
      revision: panelRevision.extend({ locale: z.object({ requested: z.string().nullable(), resolved: z.string(), fallbackChain: z.array(z.string()) }) }).nullable(),
      canonicalPath: z.string(),
    }),
    run: ({ user, query }) => northTaxonomy.resolve(user.id, query),
  });
  // --- Public showcase: anonymous, read-only, explicit opt-in (see ADR 019). ---
  const showcaseParams = z.object({ organizationSlug: z.string().trim().min(1).max(100) }).strict();
  const showcaseRevision = z.object({
    id: s.id, panelId: s.id, revisionNumber: z.number().int(), etag: z.string(), defaultLocale: z.string(),
    fallbackLocales: z.array(z.string()), document: northPanelDocumentInput,
    locale: z.object({ requested: z.string().nullable(), resolved: z.string(), fallbackChain: z.array(z.string()) }),
  });
  contract(app, {
    method: "GET", url: "/public/showcases/:organizationSlug/navigation", tag: "NORTH showcase", public: true, rateLimit: 120,
    summary: "Read the navigation of explicitly public showcase panels without authentication", params: showcaseParams,
    response: z.object({ organization: z.object({ name: s.name, slug: z.string() }), navigation }),
    run: async ({ params, reply }) => {
      reply.header("cache-control", "public, max-age=15, must-revalidate");
      return northShowcase.navigation(params.organizationSlug);
    },
  });
  contract(app, {
    method: "GET", url: "/public/showcases/:organizationSlug/resolve", tag: "NORTH showcase", public: true, rateLimit: 120,
    summary: "Resolve one published public showcase panel without authentication", params: showcaseParams,
    query: z.object({ categorySlug: z.string(), subcategorySlug: z.string(), panelSlug: z.string(), locale: z.string().optional() }).strict(),
    response: z.object({
      organization: z.object({ name: s.name, slug: z.string() }),
      category: z.object({ id: s.id, name: s.localizedText, slug: z.string() }),
      subcategory: z.object({ id: s.id, name: s.localizedText, slug: z.string() }),
      panel: z.object({ id: s.id, name: s.localizedText, description: s.localizedText.nullable(), icon: z.string().nullable(), slug: z.string(), status: z.literal("PUBLISHED") }),
      revision: showcaseRevision,
      canonicalPath: z.string(),
    }),
    run: async ({ params, query, reply }) => {
      reply.header("cache-control", "public, max-age=15, must-revalidate");
      return northShowcase.resolve(params.organizationSlug, query);
    },
  });
  contract(app, {
    method: "POST", url: "/public/showcases/:organizationSlug/panels/:panelId/analytics-bindings/:bindingId/results", tag: "NORTH showcase", public: true, rateLimit: 180,
    summary: "Resolve only a binding referenced by a public showcase panel and apply allowlisted runtime filters",
    params: showcaseParams.extend({ panelId: s.id, bindingId: s.id }),
    body: z.object({ filters: z.array(datasetQueryFilter).max(10).default([]) }).strict(),
    response: s.northAnalyticsBindingResult,
    run: async ({ params, body, reply }) => {
      reply.header("cache-control", "no-store");
      return northShowcase.results(params.organizationSlug, params.panelId, params.bindingId, body.filters);
    },
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/public-showcase", tag: "NORTH showcase",
    summary: "Enable or disable the organization's public showcase (authorized and audited)", params: s.orgParams,
    body: z.object({ enabled: z.boolean() }).strict(),
    response: z.object({ organizationId: s.id, showcaseEnabled: z.boolean() }),
    run: ({ user, params, body }) => northShowcase.setOrganization(user.id, params.organizationId, body.enabled),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/panels/:panelId/public-visibility", tag: "NORTH showcase",
    summary: "Mark a published content panel PRIVATE or SHOWCASE (authorized and audited)", params: s.orgParams.extend({ panelId: s.id }),
    body: z.object({ visibility: z.enum(["PRIVATE", "SHOWCASE"]) }).strict(),
    response: z.object({ panelId: s.id, visibility: z.enum(["PRIVATE", "SHOWCASE"]) }),
    run: ({ user, params, body }) => northShowcase.setPanelVisibility(user.id, params.organizationId, params.panelId, body.visibility),
  });
}
