import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { isNorthCapability } from "../authorization/policy.js";
import { authorizeNorth } from "./authorization.js";
import { validateNorthPanelDocument } from "./content-schema.js";
import { northContentRepository } from "./content-repository.js";
import { northRepository as repo, type Localized } from "./repository.js";
import { validateNorthSlug } from "./slug.js";
import { northTemplateSnapshotInput, type NorthTemplateSnapshot } from "./template-schema.js";
import { northResourceLimits } from "./limits.js";
import { cloneNorthPanelDocument } from "./clone-document.js";

type TemplateCreate = {
  slug: string;
  name: Localized;
  description?: Localized | null;
  snapshot: unknown;
};

function slug(value: string) {
  const result = validateNorthSlug(value, false);
  if (result.error) fail(result.error === "NORTH_SLUG_RESERVED" ? 409 : 422, result.error, "Slug is unavailable");
  return result.slug;
}

async function requirePlatformTemplateManager(tx: Transaction, actorId: string) {
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: { role: true, status: true, northPlatformGrants: { where: { capability: "north.template.manage_global" } } },
  });
  if (!actor || actor.status !== "ACTIVE" || (actor.role !== "SUPERADMIN" && (actor.role !== "ADMIN" || actor.northPlatformGrants.length === 0)))
    fail(403, "FORBIDDEN", "Platform template management permission required");
}

function uniqueSlugs(values: string[], code: string) {
  if (new Set(values).size !== values.length) fail(422, code, "Template sibling slugs must be unique");
}

async function validatedSnapshot(value: unknown, actorId: string) {
  const parsed = northTemplateSnapshotInput.safeParse(value);
  if (!parsed.success) fail(422, "TEMPLATE_INVALID", "Template snapshot is invalid");
  const snapshot = structuredClone(parsed.data);
  const limits = northResourceLimits();
  if (snapshot.subcategories.length > limits.subcategoriesPerCategory)
    fail(422, "NORTH_SUBCATEGORY_LIMIT_EXCEEDED", "Template exceeds the configured subcategory limit");
  if (snapshot.subcategories.some((item) => item.panels.length > limits.panelsPerSubcategory))
    fail(422, "NORTH_PANEL_LIMIT_EXCEEDED", "Template exceeds the configured panel limit");
  snapshot.category.slug = slug(snapshot.category.slug);
  uniqueSlugs(snapshot.subcategories.map((item) => slug(item.slug)), "TEMPLATE_SLUG_DUPLICATE");
  for (const subcategory of snapshot.subcategories) {
    subcategory.slug = slug(subcategory.slug);
    uniqueSlugs(subcategory.panels.map((item) => slug(item.slug)), "TEMPLATE_SLUG_DUPLICATE");
    for (const panel of subcategory.panels) {
      panel.slug = slug(panel.slug);
      if (panel.audience.capabilities.some((capability) => !isNorthCapability(capability)))
        fail(422, "UNKNOWN_CAPABILITY", "Template audience capability is not registered");
      if (panel.document)
        panel.document = await validateNorthPanelDocument(panel.document, { organizationId: "GLOBAL_TEMPLATE", actorId });
    }
  }
  return snapshot;
}

function view(template: {
  id: string; slug: string; name: Prisma.JsonValue; description: Prisma.JsonValue | null;
  status: "ACTIVE" | "ARCHIVED"; currentVersion: number; createdBy: string; createdAt: Date; updatedAt: Date;
}) {
  return template;
}

function etag(id: string, panelId: string) {
  return `"${createHash("sha256").update(`${id}:${panelId}:1`).digest("base64url")}"`;
}

async function applySnapshot(
  tx: Transaction,
  actorId: string,
  organizationId: string,
  templateId: string,
  version: number,
  snapshot: NorthTemplateSnapshot,
  requestedSlug?: string,
) {
  const categorySlug = slug(requestedSlug ?? snapshot.category.slug);
  if (await tx.northCategory.count({ where: { organizationId } }) >= northResourceLimits().categoriesPerOrganization)
    fail(409, "NORTH_CATEGORY_LIMIT_EXCEEDED", "Organization category limit reached");
  if (await repo.categoryBySlug(tx, organizationId, categorySlug)) fail(409, "NORTH_SLUG_TAKEN", "Slug or alias is already in use");
  const category = await repo.createCategory(tx, organizationId, {
    ...snapshot.category,
    slug: categorySlug,
    resourceKind: "CONTENT",
    categoryClass: "CUSTOM",
    sourceTemplateId: templateId,
    sourceTemplateVersion: version,
  });
  for (const sourceSubcategory of snapshot.subcategories) {
    const subcategory = await repo.createSubcategory(tx, organizationId, category.id, {
      resourceKind: "CONTENT",
      name: sourceSubcategory.name,
      description: sourceSubcategory.description,
      icon: sourceSubcategory.icon,
      color: sourceSubcategory.color,
      slug: sourceSubcategory.slug,
      navigationHidden: sourceSubcategory.navigationHidden,
    });
    for (const sourcePanel of sourceSubcategory.panels) {
      const panel = await repo.createPanel(tx, organizationId, subcategory.id, {
        resourceKind: "CONTENT",
        name: sourcePanel.name,
        description: sourcePanel.description,
        icon: sourcePanel.icon,
        color: sourcePanel.color,
        slug: sourcePanel.slug,
        navigationHidden: sourcePanel.navigationHidden,
        audienceType: sourcePanel.audience.type,
      });
      await repo.replaceAudience(tx, panel, {
        type: sourcePanel.audience.type,
        roles: sourcePanel.audience.roles,
        capabilities: sourcePanel.audience.capabilities,
        groupIds: [],
        membershipIds: [],
      });
      if (sourcePanel.document) {
        const document = cloneNorthPanelDocument(sourcePanel.document);
        const revisionId = randomUUID();
        const revision = await northContentRepository.createRevision(tx, {
          id: revisionId,
          organizationId,
          panelId: panel.id,
          revisionNumber: 1,
          etag: etag(revisionId, panel.id),
          document,
          defaultLocale: document.defaultLocale,
          fallbackLocales: document.fallbackLocales,
          message: `Applied template ${templateId} v${version}`,
          createdBy: actorId,
        });
        await northContentRepository.pointDraft(tx, panel.id, revision.id);
      }
    }
  }
  return category;
}

export const northTemplates = {
  platformList(actorId: string) {
    return transaction(async (tx) => {
      await requirePlatformTemplateManager(tx, actorId);
      return tx.northTemplate.findMany({ orderBy: [{ slug: "asc" }, { id: "asc" }] });
    });
  },
  list(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorizeNorth(tx, userId, "north.template.read", { organizationId, scope: "ORGANIZATION" });
      return tx.northTemplate.findMany({ where: { status: "ACTIVE" }, orderBy: [{ slug: "asc" }, { id: "asc" }] });
    });
  },
  read(userId: string, organizationId: string, templateId: string, version?: number) {
    return transaction(async (tx) => {
      await authorizeNorth(tx, userId, "north.template.read", { organizationId, scope: "ORGANIZATION" });
      const template = await tx.northTemplate.findFirst({ where: { id: templateId, status: "ACTIVE" } });
      if (!template) fail(404, "NOT_FOUND", "Template not found");
      const templateVersion = await tx.northTemplateVersion.findUnique({
        where: { templateId_version: { templateId, version: version ?? template.currentVersion } },
      });
      if (!templateVersion) fail(404, "NOT_FOUND", "Template version not found");
      return { ...view(template), version: templateVersion.version, snapshot: templateVersion.snapshot };
    });
  },
  create(actorId: string, input: TemplateCreate) {
    return transaction(async (tx) => {
      await requirePlatformTemplateManager(tx, actorId);
      const snapshot = await validatedSnapshot(input.snapshot, actorId);
      const templateSlug = slug(input.slug);
      let template;
      try {
        template = await tx.northTemplate.create({
          data: {
            slug: templateSlug,
            name: input.name,
            description: input.description === null ? Prisma.DbNull : input.description,
            createdBy: actorId,
            versions: { create: { version: 1, snapshot: snapshot as unknown as Prisma.InputJsonValue, createdBy: actorId } },
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          fail(409, "TEMPLATE_SLUG_TAKEN", "Template slug is already in use");
        throw error;
      }
      await audit.append(tx, { actorId, action: "TEMPLATE_CREATED", targetType: "NorthTemplate", targetId: template.id, metadata: { version: 1 } });
      return view(template);
    });
  },
  createVersion(actorId: string, templateId: string, snapshotInput: unknown) {
    return transaction(async (tx) => {
      await requirePlatformTemplateManager(tx, actorId);
      const template = await tx.northTemplate.findUnique({ where: { id: templateId } });
      if (!template) fail(404, "NOT_FOUND", "Template not found");
      const snapshot = await validatedSnapshot(snapshotInput, actorId);
      const version = template.currentVersion + 1;
      const created = await tx.northTemplateVersion.create({
        data: { templateId, version, snapshot: snapshot as unknown as Prisma.InputJsonValue, createdBy: actorId },
      });
      await tx.northTemplate.update({ where: { id: templateId }, data: { currentVersion: version } });
      await audit.append(tx, { actorId, action: "TEMPLATE_UPDATED", targetType: "NorthTemplate", targetId: templateId, metadata: { version } });
      return created;
    });
  },
  update(actorId: string, templateId: string, input: {
    slug?: string; name?: Localized; description?: Localized | null; status?: "ACTIVE" | "ARCHIVED";
  }) {
    return transaction(async (tx) => {
      await requirePlatformTemplateManager(tx, actorId);
      const current = await tx.northTemplate.findUnique({ where: { id: templateId } });
      if (!current) fail(404, "NOT_FOUND", "Template not found");
      let updated;
      try {
        updated = await tx.northTemplate.update({
          where: { id: templateId },
          data: {
            ...(input.slug ? { slug: slug(input.slug) } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.description === null ? { description: Prisma.DbNull } : input.description ? { description: input.description } : {}),
            ...(input.status ? { status: input.status } : {}),
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          fail(409, "TEMPLATE_SLUG_TAKEN", "Template slug is already in use");
        throw error;
      }
      await audit.append(tx, {
        actorId,
        action: "TEMPLATE_UPDATED",
        targetType: "NorthTemplate",
        targetId: templateId,
        metadata: { fields: Object.keys(input).sort() },
      });
      return view(updated);
    });
  },
  apply(userId: string, organizationId: string, templateId: string, input: { version?: number; slug?: string }) {
    return transaction(async (tx) => {
      await authorizeNorth(tx, userId, "north.template.apply", { organizationId, scope: "ORGANIZATION" });
      const template = await tx.northTemplate.findFirst({ where: { id: templateId, status: "ACTIVE" } });
      if (!template) fail(404, "NOT_FOUND", "Template not found");
      const version = input.version ?? template.currentVersion;
      const stored = await tx.northTemplateVersion.findUnique({ where: { templateId_version: { templateId, version } } });
      if (!stored) fail(404, "NOT_FOUND", "Template version not found");
      const snapshot = await validatedSnapshot(stored.snapshot, userId);
      const category = await applySnapshot(tx, userId, organizationId, templateId, version, snapshot, input.slug);
      await audit.append(tx, {
        actorId: userId,
        organizationId,
        action: "TEMPLATE_APPLIED",
        targetType: "NorthCategory",
        targetId: category.id,
        metadata: { templateId, sourceTemplateVersion: version },
      });
      return category;
    });
  },
};
