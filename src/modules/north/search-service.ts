import type { Prisma } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { hasNorthCapability } from "./authorization.js";
import { northPanelAudienceAllows } from "./audience.js";

export type NorthSearchQuery = {
  query: string;
  resourceType?: "CATEGORY" | "SUBCATEGORY" | "PANEL" | "ASSET";
  categoryId?: string;
  status?: "ACTIVE" | "DRAFT" | "PUBLISHED" | "ARCHIVED" | "READY";
  updatedBy?: string;
  updatedAfter?: string;
  limit: number;
};

type SearchResult = {
  id: string;
  resourceType: NorthSearchQuery["resourceType"];
  name: Prisma.JsonValue;
  description: Prisma.JsonValue | null;
  status: string;
  categoryId: string | null;
  subcategoryId: string | null;
  panelId: string | null;
  updatedAt: Date;
  updatedBy: string | null;
};

function strings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, output));
  return output;
}

const matches = (needle: string, ...values: unknown[]) =>
  values.flatMap((value) => strings(value)).some((value) => value.toLocaleLowerCase().includes(needle));

export const northSearch = {
  run(userId: string, organizationId: string, query: NorthSearchQuery) {
    return transaction(async (tx) => {
      const organization = await tx.organization.findFirst({ where: { id: organizationId, status: "ACTIVE" } });
      if (!organization) fail(404, "NOT_FOUND", "Organization not found");
      const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
      const platformAccess = await hasNorthCapability(tx, userId, "north.content.manage_all_tenants", { organizationId, scope: "ORGANIZATION" });
      if (!membership && !platformAccess) fail(404, "NOT_FOUND", "Organization not found");
      if (query.categoryId && !(await tx.northCategory.findFirst({ where: { id: query.categoryId, organizationId } })))
        fail(404, "NOT_FOUND", "Category not found");

      const needle = query.query.trim().toLocaleLowerCase();
      const updatedAfter = query.updatedAfter ? new Date(query.updatedAfter) : undefined;
      const results: SearchResult[] = [];
      const wants = (kind: NonNullable<NorthSearchQuery["resourceType"]>) => !query.resourceType || query.resourceType === kind;
      const dateAllowed = (value: Date) => !updatedAfter || value > updatedAfter;

      if (wants("CATEGORY") && (!query.status || ["ACTIVE", "ARCHIVED"].includes(query.status)) && !query.updatedBy) {
        const categories = await tx.northCategory.findMany({
          where: {
            organizationId,
            ...(query.categoryId ? { id: query.categoryId } : {}),
            ...(query.status ? { status: query.status as "ACTIVE" | "ARCHIVED" } : {}),
            ...(updatedAfter ? { updatedAt: { gt: updatedAfter } } : {}),
          },
          take: 500,
        });
        for (const category of categories) {
          if (!matches(needle, category.name, category.description)) continue;
          if (!(await hasNorthCapability(tx, userId, "north.category.read", { organizationId, scope: "CATEGORY", categoryId: category.id }))) continue;
          results.push({ id: category.id, resourceType: "CATEGORY", name: category.name, description: category.description, status: category.status, categoryId: category.id, subcategoryId: null, panelId: null, updatedAt: category.updatedAt, updatedBy: null });
        }
      }

      if (wants("SUBCATEGORY") && (!query.status || ["ACTIVE", "ARCHIVED"].includes(query.status)) && !query.updatedBy) {
        const subcategories = await tx.northSubcategory.findMany({
          where: {
            organizationId,
            ...(query.categoryId ? { categoryId: query.categoryId } : {}),
            ...(query.status ? { status: query.status as "ACTIVE" | "ARCHIVED" } : {}),
            ...(updatedAfter ? { updatedAt: { gt: updatedAfter } } : {}),
          },
          take: 500,
        });
        for (const subcategory of subcategories) {
          if (!matches(needle, subcategory.name, subcategory.description)) continue;
          const target = { organizationId, scope: "SUBCATEGORY" as const, categoryId: subcategory.categoryId, subcategoryId: subcategory.id };
          if (!(await hasNorthCapability(tx, userId, "north.subcategory.read", target))) continue;
          results.push({ id: subcategory.id, resourceType: "SUBCATEGORY", name: subcategory.name, description: subcategory.description, status: subcategory.status, categoryId: subcategory.categoryId, subcategoryId: subcategory.id, panelId: null, updatedAt: subcategory.updatedAt, updatedBy: null });
        }
      }

      if (wants("PANEL") && (!query.status || ["DRAFT", "PUBLISHED", "ARCHIVED"].includes(query.status))) {
        const panels = await tx.northPanel.findMany({
          where: {
            organizationId,
            ...(query.categoryId ? { subcategory: { categoryId: query.categoryId } } : {}),
            ...(query.status === "ARCHIVED" ? { status: "ARCHIVED" } : {}),
          },
          include: {
            subcategory: true,
            audienceRoles: true,
            audienceGroups: true,
            audiencePermissions: true,
            audienceMemberships: true,
            draftRevision: true,
            publishedRevision: true,
          },
          take: 500,
        });
        for (const panel of panels) {
          const target = { organizationId, scope: "PANEL" as const, categoryId: panel.subcategory.categoryId, subcategoryId: panel.subcategoryId, panelId: panel.id };
          const draftRequested = query.status === "DRAFT";
          const archivedRequested = query.status === "ARCHIVED";
          const revision = draftRequested ? panel.draftRevision : archivedRequested ? null : panel.publishedRevision;
          if (draftRequested) {
            if (!revision || !(await hasNorthCapability(tx, userId, "north.panel.preview", target))) continue;
          } else if (archivedRequested) {
            if (!(await hasNorthCapability(tx, userId, "north.panel.read", target))) continue;
          } else {
            if (panel.status !== "PUBLISHED" || !revision) continue;
            if (!(await hasNorthCapability(tx, userId, "north.panel.read", target))) continue;
            if (!(await northPanelAudienceAllows(tx, userId, panel, panel.subcategory.categoryId))) continue;
          }
          const updatedAt = revision?.createdAt ?? panel.updatedAt;
          const updatedBy = revision?.createdBy ?? null;
          if (!dateAllowed(updatedAt) || (query.updatedBy && updatedBy !== query.updatedBy)) continue;
          if (!matches(needle, panel.name, panel.description, revision?.document)) continue;
          results.push({ id: panel.id, resourceType: "PANEL", name: panel.name, description: panel.description, status: draftRequested ? "DRAFT" : panel.status, categoryId: panel.subcategory.categoryId, subcategoryId: panel.subcategoryId, panelId: panel.id, updatedAt, updatedBy });
        }
      }

      if (wants("ASSET") && !query.categoryId && (!query.status || query.status === "READY")) {
        const assets = await tx.northAsset.findMany({
          where: {
            organizationId,
            deletedAt: null,
            status: "READY",
            ...(query.updatedBy ? { ownerId: query.updatedBy } : {}),
            ...(updatedAfter ? { updatedAt: { gt: updatedAfter } } : {}),
          },
          take: 500,
        });
        const canReadAssets = await hasNorthCapability(tx, userId, "north.asset.read", { organizationId, scope: "ORGANIZATION" });
        if (canReadAssets) for (const asset of assets) {
          if (!matches(needle, asset.filename, asset.mime)) continue;
          results.push({ id: asset.id, resourceType: "ASSET", name: { und: asset.filename }, description: { und: asset.mime }, status: asset.status, categoryId: null, subcategoryId: null, panelId: null, updatedAt: asset.updatedAt, updatedBy: asset.ownerId });
        }
      }

      return results
        .sort((left, right) => right.updatedAt.valueOf() - left.updatedAt.valueOf() || left.id.localeCompare(right.id))
        .slice(0, query.limit);
    });
  },
};
