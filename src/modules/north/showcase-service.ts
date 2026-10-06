import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorizeNorth } from "./authorization.js";
import type { NorthPanelDocument } from "./content-schema.js";
import { allowedBindingFilterSchema, datasetQuerySchema, type DatasetQuery, type DatasetQueryFilter } from "./data/query-contract.js";
import { executeDatasetQuery } from "./data/query-service.js";
import { northPanelDocumentInput } from "./content-schema.js";

/**
 * Public showcase. This is a separate, explicit and revocable publication policy;
 * it never reinterprets membership audiences as public. Every public read requires
 * ALL of: an ACTIVE organization with `showcaseEnabled`, ACTIVE category and
 * subcategory, and a PUBLISHED CONTENT panel whose visibility is SHOWCASE.
 * Anything else is a generic 404 so private resources cannot be enumerated.
 */
export type ShowcaseState = {
  organization: { status: string; showcaseEnabled: boolean };
  category: { status: string; navigationHidden: boolean };
  subcategory: { status: string; navigationHidden: boolean };
  panel: { status: string; visibility: string; resourceKind: string; navigationHidden: boolean };
};

export function showcaseVisible(state: ShowcaseState) {
  return state.organization.status === "ACTIVE"
    && state.organization.showcaseEnabled
    && state.category.status === "ACTIVE" && !state.category.navigationHidden
    && state.subcategory.status === "ACTIVE" && !state.subcategory.navigationHidden
    && state.panel.status === "PUBLISHED"
    && state.panel.visibility === "SHOWCASE"
    && state.panel.resourceKind === "CONTENT"
    && !state.panel.navigationHidden;
}

function notFound(): never {
  return fail(404, "NOT_FOUND", "Content not found");
}

async function showcaseOrganization(tx: Transaction, slug: string) {
  const organization = await tx.organization.findFirst({ where: { slug, status: "ACTIVE", showcaseEnabled: true } });
  if (!organization) notFound();
  return organization!;
}

/** `referenced` mirrors the authenticated path: only bindings the published document actually uses. */
function referenced(document: NorthPanelDocument, bindingId: string, datasetId: string) {
  return document.sections.some((section) => section.components.some((component) =>
    Object.values(component.bindings).some((binding) => binding.sourceType === "dataset" && binding.sourceId === bindingId && binding.datasetId === datasetId)));
}

export const northShowcase = {
  /** Only branches with at least one public panel survive, so private structure is not disclosed. */
  navigation(slug: string) {
    return transaction(async (tx) => {
      const organization = await showcaseOrganization(tx, slug);
      const categories = await tx.northCategory.findMany({
        where: { organizationId: organization.id, status: "ACTIVE", navigationHidden: false },
        orderBy: [{ order: "asc" }, { id: "asc" }],
        include: {
          subcategories: {
            where: { status: "ACTIVE", navigationHidden: false },
            orderBy: [{ order: "asc" }, { id: "asc" }],
            include: {
              panels: {
                where: { status: "PUBLISHED", visibility: "SHOWCASE", resourceKind: "CONTENT", navigationHidden: false },
                orderBy: [{ order: "asc" }, { id: "asc" }],
              },
            },
          },
        },
      });
      const result = [];
      for (const category of categories) {
        const subcategories = category.subcategories
          .filter((subcategory) => subcategory.panels.length > 0)
          .map((subcategory) => ({
            id: subcategory.id, name: subcategory.name, icon: subcategory.icon, slug: subcategory.slug,
            panels: subcategory.panels.map((panel) => ({ id: panel.id, name: panel.name, icon: panel.icon, slug: panel.slug, status: panel.status })),
          }));
        if (subcategories.length > 0)
          result.push({ id: category.id, name: category.name, icon: category.icon, color: category.color, slug: category.slug, subcategories });
      }
      return { organization: { name: organization.name, slug: organization.slug }, navigation: result };
    });
  },

  resolve(slug: string, slugs: { categorySlug: string; subcategorySlug: string; panelSlug: string; locale?: string }) {
    return transaction(async (tx) => {
      const organization = await showcaseOrganization(tx, slug);
      const category = await tx.northCategory.findUnique({ where: { organizationId_slug: { organizationId: organization.id, slug: slugs.categorySlug } } });
      if (!category) notFound();
      const subcategory = await tx.northSubcategory.findUnique({ where: { categoryId_slug: { categoryId: category!.id, slug: slugs.subcategorySlug } } });
      if (!subcategory) notFound();
      const panel = await tx.northPanel.findUnique({ where: { subcategoryId_slug: { subcategoryId: subcategory!.id, slug: slugs.panelSlug } }, include: { publishedRevision: true } });
      if (!panel?.publishedRevision || !showcaseVisible({ organization, category: category!, subcategory: subcategory!, panel })) notFound();
      const revision = panel!.publishedRevision!;
      const allowed = new Set([revision.defaultLocale, ...(revision.fallbackLocales as string[])]);
      const resolved = slugs.locale && allowed.has(slugs.locale) ? slugs.locale : revision.defaultLocale;
      return {
        organization: { name: organization.name, slug: organization.slug },
        category: { id: category!.id, name: category!.name, slug: category!.slug },
        subcategory: { id: subcategory!.id, name: subcategory!.name, slug: subcategory!.slug },
        panel: { id: panel!.id, name: panel!.name, description: panel!.description, icon: panel!.icon, slug: panel!.slug, status: panel!.status },
        revision: {
          id: revision.id, panelId: revision.panelId, revisionNumber: revision.revisionNumber, etag: revision.etag,
          defaultLocale: revision.defaultLocale, fallbackLocales: revision.fallbackLocales as string[], document: revision.document,
          locale: { requested: slugs.locale ?? null, resolved, fallbackChain: [resolved, ...[...allowed].filter((item) => item !== resolved)] },
        },
        canonicalPath: `/showcase/${organization.slug}/${category!.slug}/${subcategory!.slug}/${panel!.slug}`,
      };
    });
  },

  /** Same bounded engine and allowlisted filters as the member path; no extra capability beyond publication. */
  results(slug: string, panelId: string, bindingId: string, runtimeFilters: DatasetQueryFilter[]) {
    return transaction(async (tx) => {
      const organization = await showcaseOrganization(tx, slug);
      const panel = await tx.northPanel.findFirst({
        where: { id: panelId, organizationId: organization.id },
        include: { publishedRevision: true, subcategory: { include: { category: true } } },
      });
      if (!panel?.publishedRevision || !showcaseVisible({ organization, category: panel.subcategory.category, subcategory: panel.subcategory, panel })) notFound();
      const binding = await tx.northAnalyticsBinding.findFirst({ where: { id: bindingId, organizationId: organization.id, panelId } });
      const document = northPanelDocumentInput.parse(panel!.publishedRevision!.document);
      if (!binding || !referenced(document, binding.id, binding.datasetId)) notFound();
      const dataset = await tx.northDataset.findFirst({ where: { id: binding.datasetId, organizationId: organization.id, status: "ACTIVE" } });
      if (!dataset) notFound();
      const query = datasetQuerySchema.parse(binding.query);
      const allowed = allowedBindingFilterSchema.array().parse(binding.allowedFilters);
      const policy = new Map(allowed.map((item) => [item.fieldId, new Set(item.operators)]));
      if (runtimeFilters.length > 10 || runtimeFilters.some((item) => !policy.get(item.fieldId)?.has(item.operator)))
        fail(422, "BINDING_FILTER_NOT_ALLOWED", "A runtime filter is not allowed by this binding");
      const effective = { ...query, filters: [...(query.filters ?? []), ...runtimeFilters] } as DatasetQuery;
      if ((effective.filters?.length ?? 0) > 10) fail(422, "BINDING_FILTER_LIMIT_EXCEEDED", "Binding filters exceed the maximum of 10");
      const result = await executeDatasetQuery(tx, organization.id, binding.datasetId, effective);
      const definitions = allowed.length
        ? await tx.northDatasetField.findMany({
          where: { organizationId: organization.id, datasetId: binding.datasetId, id: { in: allowed.map((item) => item.fieldId) } },
          select: { id: true, key: true, displayName: true, canonicalType: true },
        })
        : [];
      const byId = new Map(definitions.map((field) => [field.id, field]));
      const filterDefinitions = allowed.map((item) => {
        const field = byId.get(item.fieldId);
        if (!field) fail(422, "BINDING_FILTER_INVALID", "An allowed filter field no longer exists");
        return { fieldId: field!.id, key: field!.key, displayName: field!.displayName, type: field!.canonicalType, operators: item.operators };
      });
      return { bindingId, filterDefinitions, ...result };
    });
  },

  /** Publication configuration is authorized and audited like any other publish transition. */
  setOrganization(userId: string, organizationId: string, enabled: boolean) {
    return transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
      if (!membership) fail(404, "NOT_FOUND", "Organization not found");
      await authorizeNorth(tx, userId, "north.panel.publish", { organizationId, scope: "ORGANIZATION" });
      const updated = await tx.organization.update({ where: { id: organizationId }, data: { showcaseEnabled: enabled } });
      await audit.append(tx, { actorId: userId, organizationId, action: enabled ? "SHOWCASE_ENABLED" : "SHOWCASE_DISABLED", targetType: "Organization", targetId: organizationId });
      return { organizationId, showcaseEnabled: updated.showcaseEnabled };
    });
  },

  setPanelVisibility(userId: string, organizationId: string, panelId: string, visibility: "PRIVATE" | "SHOWCASE") {
    return transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
      if (!membership) fail(404, "NOT_FOUND", "Panel not found");
      const panel = await tx.northPanel.findFirst({ where: { id: panelId, organizationId }, include: { subcategory: true } });
      if (!panel) fail(404, "NOT_FOUND", "Panel not found");
      if (panel!.resourceKind !== "CONTENT") fail(422, "SHOWCASE_PANEL_INVALID", "Only content panels can be shown publicly");
      await authorizeNorth(tx, userId, "north.panel.publish", { organizationId, scope: "PANEL", categoryId: panel!.subcategory.categoryId, subcategoryId: panel!.subcategoryId, panelId });
      const updated = await tx.northPanel.update({ where: { id: panelId }, data: { visibility } });
      await audit.append(tx, { actorId: userId, organizationId, action: visibility === "SHOWCASE" ? "PANEL_SHOWCASE_PUBLISHED" : "PANEL_SHOWCASE_REVOKED", targetType: "NorthPanel", targetId: panelId });
      return { panelId, visibility: updated.visibility };
    });
  },
};
