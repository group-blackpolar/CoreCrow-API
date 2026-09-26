import { Prisma } from "../../lib/database.js";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { auditRepository as audit } from "../audit/repository.js";
import { isNorthCapability } from "../authorization/policy.js";
import { authorizeNorth, hasNorthCapability, requireGrantAuthority } from "./authorization.js";
import { northRepository as repo } from "./repository.js";
import { validateNorthSlug } from "./slug.js";
import { cloneNorthPanelContent, northContent } from "./content-service.js";
import { northPanelAudienceAllows } from "./audience.js";
import { northResourceLimits } from "./limits.js";
function slugOf(value, system = false) {
    const result = validateNorthSlug(value, system);
    if (result.error)
        fail(result.error === "NORTH_SLUG_RESERVED" ? 409 : 422, result.error, "Slug is unavailable");
    return result.slug;
}
function conflict(error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        fail(409, "NORTH_SLUG_TAKEN", "Slug or grant is already in use");
    throw error;
}
const label = (value) => ({ es: value, en: value });
export async function bootstrapNorthOrganization(tx, organizationId) {
    const homeCategory = await tx.northCategory.upsert({
        where: { organizationId_slug: { organizationId, slug: "home" } },
        create: { organizationId, scope: "ORGANIZATION", resourceKind: "SYSTEM", categoryClass: "SYSTEM", name: label("Home"), slug: "home", order: 0 },
        update: {},
    });
    const homeSubcategory = await tx.northSubcategory.upsert({
        where: { categoryId_slug: { categoryId: homeCategory.id, slug: "overview" } },
        create: { organizationId, categoryId: homeCategory.id, resourceKind: "SYSTEM", name: label("Overview"), slug: "overview", order: 0 },
        update: {},
    });
    const homePanel = await tx.northPanel.upsert({
        where: { subcategoryId_slug: { subcategoryId: homeSubcategory.id, slug: "home" } },
        create: { organizationId, subcategoryId: homeSubcategory.id, resourceKind: "SYSTEM", name: label("Home"), slug: "home", status: "PUBLISHED", order: 0 },
        update: {},
    });
    const adminCategory = await tx.northCategory.upsert({
        where: { organizationId_slug: { organizationId, slug: "admin" } },
        create: { organizationId, scope: "ORGANIZATION", resourceKind: "SYSTEM", categoryClass: "SYSTEM", name: label("Administration"), slug: "admin", order: 1000 },
        update: {},
    });
    const adminSubcategory = await tx.northSubcategory.upsert({
        where: { categoryId_slug: { categoryId: adminCategory.id, slug: "settings" } },
        create: { organizationId, categoryId: adminCategory.id, resourceKind: "SYSTEM", name: label("Settings"), slug: "settings", order: 0 },
        update: {},
    });
    const adminPanel = await tx.northPanel.upsert({
        where: { subcategoryId_slug: { subcategoryId: adminSubcategory.id, slug: "administration" } },
        create: { organizationId, subcategoryId: adminSubcategory.id, resourceKind: "SYSTEM", name: label("Administration"), slug: "administration", status: "PUBLISHED", order: 0, audienceType: "ROLES" },
        update: {},
    });
    await tx.northPanelAudienceRole.createMany({
        data: [{ organizationId, panelId: adminPanel.id, role: "OWNER" }, { organizationId, panelId: adminPanel.id, role: "ADMIN" }],
        skipDuplicates: true,
    });
    for (const role of ["MEMBER", "VIEWER", "BILLING_ADMIN"]) {
        for (const capability of ["north.category.read", "north.subcategory.read", "north.panel.read", "north.content.read"]) {
            const exists = await tx.northRoleGrant.findFirst({ where: { organizationId, role, capability, scope: "ORGANIZATION", categoryId: null, subcategoryId: null, panelId: null } });
            if (!exists)
                await tx.northRoleGrant.create({ data: { organizationId, role, capability, scope: "ORGANIZATION" } });
        }
    }
    await tx.organization.updateMany({ where: { id: organizationId, homePanelId: null }, data: { homePanelId: homePanel.id } });
    return homePanel;
}
async function categoryTarget(tx, organizationId, id) {
    const value = await repo.category(tx, organizationId, id);
    if (!value)
        fail(404, "NOT_FOUND", "Category not found");
    return { organizationId, scope: "CATEGORY", categoryId: value.id };
}
async function subcategoryTarget(tx, organizationId, id) {
    const value = await repo.subcategory(tx, organizationId, id);
    if (!value)
        fail(404, "NOT_FOUND", "Subcategory not found");
    return { organizationId, scope: "SUBCATEGORY", categoryId: value.categoryId, subcategoryId: value.id };
}
async function panelTarget(tx, organizationId, id) {
    const value = await repo.panel(tx, organizationId, id);
    if (!value)
        fail(404, "NOT_FOUND", "Panel not found");
    const subcategory = await repo.subcategory(tx, organizationId, value.subcategoryId);
    if (!subcategory)
        fail(404, "NOT_FOUND", "Panel not found");
    return { organizationId, scope: "PANEL", categoryId: subcategory.categoryId, subcategoryId: subcategory.id, panelId: value.id };
}
async function ensureCategorySlug(tx, organizationId, slug, currentId) {
    const existing = await repo.categoryBySlug(tx, organizationId, slug);
    if (existing && existing.id !== currentId)
        fail(409, "NORTH_SLUG_TAKEN", "Slug or alias is already in use");
}
async function ensureSubcategorySlug(tx, categoryId, slug, currentId) {
    const existing = await repo.subcategoryBySlug(tx, categoryId, slug);
    if (existing && existing.id !== currentId)
        fail(409, "NORTH_SLUG_TAKEN", "Slug or alias is already in use");
}
async function ensurePanelSlug(tx, subcategoryId, slug, currentId) {
    const existing = await repo.panelBySlug(tx, subcategoryId, slug);
    if (existing && existing.id !== currentId)
        fail(409, "NORTH_SLUG_TAKEN", "Slug or alias is already in use");
}
async function activeCategory(tx, organizationId, categoryId) {
    const category = await repo.category(tx, organizationId, categoryId);
    if (!category)
        fail(404, "NOT_FOUND", "Category not found");
    if (category.status !== "ACTIVE")
        fail(409, "RESOURCE_ARCHIVED", "Category is archived");
    return category;
}
async function activeSubcategory(tx, organizationId, subcategoryId) {
    const subcategory = await repo.subcategory(tx, organizationId, subcategoryId);
    if (!subcategory)
        fail(404, "NOT_FOUND", "Subcategory not found");
    if (subcategory.status !== "ACTIVE")
        fail(409, "RESOURCE_ARCHIVED", "Subcategory is archived");
    await activeCategory(tx, organizationId, subcategory.categoryId);
    return subcategory;
}
async function assertSubcategoryCapacity(tx, categoryId, incoming = 1) {
    const count = await tx.northSubcategory.count({ where: { categoryId } });
    if (count + incoming > northResourceLimits().subcategoriesPerCategory)
        fail(409, "NORTH_SUBCATEGORY_LIMIT_EXCEEDED", "Category subcategory limit reached");
}
async function assertPanelCapacity(tx, subcategoryId, incoming = 1) {
    const count = await tx.northPanel.count({ where: { subcategoryId } });
    if (count + incoming > northResourceLimits().panelsPerSubcategory)
        fail(409, "NORTH_PANEL_LIMIT_EXCEEDED", "Subcategory panel limit reached");
}
async function audienceAllows(tx, userId, panel) {
    if (!panel)
        return false;
    const subcategory = await repo.subcategory(tx, panel.organizationId, panel.subcategoryId);
    return Boolean(subcategory && await northPanelAudienceAllows(tx, userId, panel, subcategory.categoryId));
}
export const northTaxonomy = {
    ensureBootstrap(organizationId) {
        return transaction((tx) => bootstrapNorthOrganization(tx, organizationId));
    },
    managementTree(userId, organizationId) {
        return transaction(async (tx) => {
            const membership = await repo.membership(tx, organizationId, userId);
            if (!membership)
                fail(404, "NOT_FOUND", "Organization not found");
            await authorizeNorth(tx, userId, "north.category.create", {
                organizationId,
                scope: "ORGANIZATION",
            });
            return repo.managementTree(tx, organizationId);
        });
    },
    readPanel(userId, organizationId, id) {
        return transaction(async (tx) => {
            const target = await panelTarget(tx, organizationId, id);
            await authorizeNorth(tx, userId, "north.panel.read", target);
            return repo.panel(tx, organizationId, id);
        });
    },
    createCategory(userId, organizationId, input) {
        return transaction(async (tx) => {
            await authorizeNorth(tx, userId, "north.category.create", { organizationId, scope: "ORGANIZATION" });
            const categoryClass = input.categoryClass ?? "CUSTOM";
            if (categoryClass !== "CUSTOM")
                fail(403, "PLATFORM_TEMPLATE_REQUIRED", "Global templates use the platform template API");
            if (await tx.northCategory.count({ where: { organizationId } }) >= northResourceLimits().categoriesPerOrganization)
                fail(409, "NORTH_CATEGORY_LIMIT_EXCEEDED", "Organization category limit reached");
            try {
                const slug = slugOf(input.slug ?? Object.values(input.name)[0] ?? "");
                await ensureCategorySlug(tx, organizationId, slug);
                const result = await repo.createCategory(tx, organizationId, { ...input, categoryClass, resourceKind: input.resourceKind ?? "CONTENT", slug });
                await audit.append(tx, { actorId: userId, organizationId, action: "CATEGORY_CREATED", targetType: "NorthCategory", targetId: result.id });
                return result;
            }
            catch (error) {
                conflict(error);
            }
        });
    },
    updateCategory(userId, organizationId, id, input) {
        return transaction(async (tx) => {
            const target = await categoryTarget(tx, organizationId, id);
            await authorizeNorth(tx, userId, "north.category.update", target);
            const current = await repo.category(tx, organizationId, id);
            if (current.resourceKind === "SYSTEM" && input.slug)
                fail(403, "SYSTEM_RESOURCE_PROTECTED", "System slugs cannot be changed");
            try {
                const slug = input.slug ? slugOf(input.slug) : undefined;
                if (slug)
                    await ensureCategorySlug(tx, organizationId, slug, id);
                if (slug && slug !== current.slug)
                    await repo.aliasCategory(tx, organizationId, id, current.slug);
                const result = await repo.updateCategory(tx, id, { ...input, ...(slug ? { slug } : {}) });
                await audit.append(tx, { actorId: userId, organizationId, action: "CATEGORY_UPDATED", targetType: "NorthCategory", targetId: id });
                return result;
            }
            catch (error) {
                conflict(error);
            }
        });
    },
    archiveCategory(userId, organizationId, id) {
        return transaction(async (tx) => {
            const target = await categoryTarget(tx, organizationId, id);
            await authorizeNorth(tx, userId, "north.category.archive", target);
            const current = await repo.category(tx, organizationId, id);
            if (current.resourceKind === "SYSTEM")
                fail(403, "SYSTEM_RESOURCE_PROTECTED", "System resources cannot be archived");
            const result = await repo.updateCategory(tx, id, { status: "ARCHIVED" });
            await audit.append(tx, { actorId: userId, organizationId, action: "CATEGORY_ARCHIVED", targetType: "NorthCategory", targetId: id });
            return result;
        });
    },
    createSubcategory(userId, organizationId, categoryId, input) {
        return transaction(async (tx) => {
            const target = await categoryTarget(tx, organizationId, categoryId);
            await authorizeNorth(tx, userId, "north.subcategory.create", target);
            await activeCategory(tx, organizationId, categoryId);
            await assertSubcategoryCapacity(tx, categoryId);
            try {
                const slug = slugOf(input.slug ?? Object.values(input.name)[0] ?? "", input.resourceKind === "SYSTEM");
                await ensureSubcategorySlug(tx, categoryId, slug);
                const result = await repo.createSubcategory(tx, organizationId, categoryId, { ...input, resourceKind: input.resourceKind ?? "CONTENT", slug });
                await audit.append(tx, { actorId: userId, organizationId, action: "SUBCATEGORY_CREATED", targetType: "NorthSubcategory", targetId: result.id });
                return result;
            }
            catch (error) {
                conflict(error);
            }
        });
    },
    updateSubcategory(userId, organizationId, id, input) {
        return transaction(async (tx) => {
            const target = await subcategoryTarget(tx, organizationId, id);
            await authorizeNorth(tx, userId, "north.subcategory.update", target);
            const current = await repo.subcategory(tx, organizationId, id);
            if (current.resourceKind === "SYSTEM" && (input.slug || input.categoryId))
                fail(403, "SYSTEM_RESOURCE_PROTECTED", "System resources cannot be moved or renamed");
            if (input.categoryId) {
                const destination = await categoryTarget(tx, organizationId, input.categoryId);
                await authorizeNorth(tx, userId, "north.subcategory.create", destination);
                await activeCategory(tx, organizationId, input.categoryId);
                if (input.categoryId !== current.categoryId)
                    await assertSubcategoryCapacity(tx, input.categoryId);
            }
            try {
                const destinationId = input.categoryId ?? current.categoryId;
                const slug = input.slug ? slugOf(input.slug) : undefined;
                await ensureSubcategorySlug(tx, destinationId, slug ?? current.slug, id);
                if (slug && slug !== current.slug)
                    await repo.aliasSubcategory(tx, current.categoryId, id, current.slug);
                const result = await repo.updateSubcategory(tx, id, { ...input, categoryId: destinationId, ...(slug ? { slug } : {}) });
                await audit.append(tx, { actorId: userId, organizationId, action: "SUBCATEGORY_UPDATED", targetType: "NorthSubcategory", targetId: id });
                return result;
            }
            catch (error) {
                conflict(error);
            }
        });
    },
    archiveSubcategory(userId, organizationId, id) {
        return transaction(async (tx) => { const target = await subcategoryTarget(tx, organizationId, id); await authorizeNorth(tx, userId, "north.subcategory.archive", target); const current = await repo.subcategory(tx, organizationId, id); if (current.resourceKind === "SYSTEM")
            fail(403, "SYSTEM_RESOURCE_PROTECTED", "System resources cannot be archived"); const result = await repo.updateSubcategory(tx, id, { status: "ARCHIVED" }); await audit.append(tx, { actorId: userId, organizationId, action: "SUBCATEGORY_ARCHIVED", targetType: "NorthSubcategory", targetId: id }); return result; });
    },
    createPanel(userId, organizationId, subcategoryId, input) {
        return transaction(async (tx) => { const target = await subcategoryTarget(tx, organizationId, subcategoryId); await authorizeNorth(tx, userId, "north.panel.create", target); await activeSubcategory(tx, organizationId, subcategoryId); await assertPanelCapacity(tx, subcategoryId); try {
            const slug = slugOf(input.slug ?? Object.values(input.name)[0] ?? "", input.resourceKind === "SYSTEM");
            await ensurePanelSlug(tx, subcategoryId, slug);
            const result = await repo.createPanel(tx, organizationId, subcategoryId, { ...input, resourceKind: input.resourceKind ?? "CONTENT", slug });
            await audit.append(tx, { actorId: userId, organizationId, action: "PANEL_CREATED", targetType: "NorthPanel", targetId: result.id });
            return result;
        }
        catch (error) {
            conflict(error);
        } });
    },
    updatePanel(userId, organizationId, id, input) {
        return transaction(async (tx) => { const target = await panelTarget(tx, organizationId, id); await authorizeNorth(tx, userId, "north.panel.update", target); const current = await repo.panel(tx, organizationId, id); if (current.resourceKind === "SYSTEM" && (input.slug || input.subcategoryId))
            fail(403, "SYSTEM_RESOURCE_PROTECTED", "System resources cannot be moved or renamed"); if (input.subcategoryId) {
            await authorizeNorth(tx, userId, "north.panel.create", await subcategoryTarget(tx, organizationId, input.subcategoryId));
            await activeSubcategory(tx, organizationId, input.subcategoryId);
            if (input.subcategoryId !== current.subcategoryId)
                await assertPanelCapacity(tx, input.subcategoryId);
        } try {
            const destinationId = input.subcategoryId ?? current.subcategoryId;
            const slug = input.slug ? slugOf(input.slug) : undefined;
            await ensurePanelSlug(tx, destinationId, slug ?? current.slug, id);
            if (slug && slug !== current.slug)
                await repo.aliasPanel(tx, current.subcategoryId, id, current.slug);
            const result = await repo.updatePanel(tx, id, { ...input, subcategoryId: destinationId, ...(slug ? { slug } : {}) });
            await audit.append(tx, { actorId: userId, organizationId, action: "PANEL_UPDATED", targetType: "NorthPanel", targetId: id });
            return result;
        }
        catch (error) {
            conflict(error);
        } });
    },
    archivePanel(userId, organizationId, id) {
        return transaction(async (tx) => { const target = await panelTarget(tx, organizationId, id); await authorizeNorth(tx, userId, "north.panel.archive", target); const current = await repo.panel(tx, organizationId, id); if (current.resourceKind === "SYSTEM")
            fail(403, "SYSTEM_RESOURCE_PROTECTED", "System resources cannot be archived"); const result = await repo.updatePanel(tx, id, { status: "ARCHIVED" }); await audit.append(tx, { actorId: userId, organizationId, action: "PANEL_ARCHIVED", targetType: "NorthPanel", targetId: id }); return result; });
    },
    clone(userId, organizationId, input) {
        return transaction(async (tx) => {
            const slug = slugOf(input.slug);
            let result;
            if (input.kind === "CATEGORY") {
                const target = await categoryTarget(tx, organizationId, input.sourceId);
                await authorizeNorth(tx, userId, "north.category.read", target);
                await authorizeNorth(tx, userId, "north.category.create", { organizationId, scope: "ORGANIZATION" });
                const source = await tx.northCategory.findFirst({ where: { id: input.sourceId, organizationId }, include: { subcategories: { where: { status: "ACTIVE" }, include: { panels: { where: { status: { not: "ARCHIVED" } }, include: { audienceRoles: true, audienceGroups: true, audiencePermissions: true, audienceMemberships: true } } } } } });
                if (!source || source.resourceKind !== "CONTENT")
                    fail(403, "SYSTEM_RESOURCE_PROTECTED", "Only content resources can be cloned");
                if (await tx.northCategory.count({ where: { organizationId } }) >= northResourceLimits().categoriesPerOrganization)
                    fail(409, "NORTH_CATEGORY_LIMIT_EXCEEDED", "Organization category limit reached");
                if (source.subcategories.length > northResourceLimits().subcategoriesPerCategory)
                    fail(409, "NORTH_SUBCATEGORY_LIMIT_EXCEEDED", "Cloned category exceeds the subcategory limit");
                if (source.subcategories.some((item) => item.panels.length > northResourceLimits().panelsPerSubcategory))
                    fail(409, "NORTH_PANEL_LIMIT_EXCEEDED", "Cloned subcategory exceeds the panel limit");
                await ensureCategorySlug(tx, organizationId, slug);
                result = await repo.createCategory(tx, organizationId, { resourceKind: "CONTENT", categoryClass: "CUSTOM", name: source.name, description: source.description, icon: source.icon, color: source.color, slug, navigationHidden: source.navigationHidden });
                for (const subcategory of source.subcategories) {
                    await authorizeNorth(tx, userId, "north.subcategory.read", await subcategoryTarget(tx, organizationId, subcategory.id));
                    const clonedSubcategory = await repo.createSubcategory(tx, organizationId, result.id, { resourceKind: "CONTENT", name: subcategory.name, description: subcategory.description, icon: subcategory.icon, color: subcategory.color, slug: subcategory.slug, order: subcategory.order, navigationHidden: subcategory.navigationHidden });
                    for (const panel of subcategory.panels) {
                        await authorizeNorth(tx, userId, "north.panel.read", await panelTarget(tx, organizationId, panel.id));
                        const clonedPanel = await repo.createPanel(tx, organizationId, clonedSubcategory.id, { resourceKind: "CONTENT", name: panel.name, description: panel.description, icon: panel.icon, color: panel.color, slug: panel.slug, order: panel.order, navigationHidden: panel.navigationHidden, audienceType: panel.audienceType });
                        await repo.replaceAudience(tx, clonedPanel, { type: panel.audienceType, roles: panel.audienceRoles.map((entry) => entry.role), groupIds: panel.audienceGroups.map((entry) => entry.groupId), capabilities: panel.audiencePermissions.map((entry) => entry.capability), membershipIds: panel.audienceMemberships.map((entry) => entry.membershipId) });
                        await cloneNorthPanelContent(tx, userId, organizationId, panel.id, clonedPanel.id);
                    }
                }
            }
            else if (input.kind === "SUBCATEGORY") {
                if (!input.destinationParentId)
                    fail(422, "CLONE_DESTINATION_REQUIRED", "Destination category is required");
                const sourceTarget = await subcategoryTarget(tx, organizationId, input.sourceId);
                await authorizeNorth(tx, userId, "north.subcategory.read", sourceTarget);
                const destination = await categoryTarget(tx, organizationId, input.destinationParentId);
                await authorizeNorth(tx, userId, "north.subcategory.create", destination);
                await activeCategory(tx, organizationId, input.destinationParentId);
                await assertSubcategoryCapacity(tx, input.destinationParentId);
                const source = await tx.northSubcategory.findFirst({ where: { id: input.sourceId, organizationId }, include: { panels: { where: { status: { not: "ARCHIVED" } }, include: { audienceRoles: true, audienceGroups: true, audiencePermissions: true, audienceMemberships: true } } } });
                if (!source || source.resourceKind !== "CONTENT")
                    fail(403, "SYSTEM_RESOURCE_PROTECTED", "Only content resources can be cloned");
                if (source.panels.length > northResourceLimits().panelsPerSubcategory)
                    fail(409, "NORTH_PANEL_LIMIT_EXCEEDED", "Cloned subcategory exceeds the panel limit");
                await ensureSubcategorySlug(tx, input.destinationParentId, slug);
                result = await repo.createSubcategory(tx, organizationId, input.destinationParentId, { resourceKind: "CONTENT", name: source.name, description: source.description, icon: source.icon, color: source.color, slug, navigationHidden: source.navigationHidden });
                for (const panel of source.panels) {
                    await authorizeNorth(tx, userId, "north.panel.read", await panelTarget(tx, organizationId, panel.id));
                    const clonedPanel = await repo.createPanel(tx, organizationId, result.id, { resourceKind: "CONTENT", name: panel.name, description: panel.description, icon: panel.icon, color: panel.color, slug: panel.slug, order: panel.order, navigationHidden: panel.navigationHidden, audienceType: panel.audienceType });
                    await repo.replaceAudience(tx, clonedPanel, { type: panel.audienceType, roles: panel.audienceRoles.map((entry) => entry.role), groupIds: panel.audienceGroups.map((entry) => entry.groupId), capabilities: panel.audiencePermissions.map((entry) => entry.capability), membershipIds: panel.audienceMemberships.map((entry) => entry.membershipId) });
                    await cloneNorthPanelContent(tx, userId, organizationId, panel.id, clonedPanel.id);
                }
            }
            else {
                if (!input.destinationParentId)
                    fail(422, "CLONE_DESTINATION_REQUIRED", "Destination subcategory is required");
                const sourceTarget = await panelTarget(tx, organizationId, input.sourceId);
                await authorizeNorth(tx, userId, "north.panel.read", sourceTarget);
                const destination = await subcategoryTarget(tx, organizationId, input.destinationParentId);
                await authorizeNorth(tx, userId, "north.panel.create", destination);
                await activeSubcategory(tx, organizationId, input.destinationParentId);
                await assertPanelCapacity(tx, input.destinationParentId);
                const source = await tx.northPanel.findFirst({ where: { id: input.sourceId, organizationId }, include: { audienceRoles: true, audienceGroups: true, audiencePermissions: true, audienceMemberships: true } });
                if (!source || source.resourceKind !== "CONTENT")
                    fail(403, "SYSTEM_RESOURCE_PROTECTED", "Only content resources can be cloned");
                await ensurePanelSlug(tx, input.destinationParentId, slug);
                result = await repo.createPanel(tx, organizationId, input.destinationParentId, { resourceKind: "CONTENT", name: source.name, description: source.description, icon: source.icon, color: source.color, slug, navigationHidden: source.navigationHidden, audienceType: source.audienceType });
                await repo.replaceAudience(tx, result, { type: source.audienceType, roles: source.audienceRoles.map((entry) => entry.role), groupIds: source.audienceGroups.map((entry) => entry.groupId), capabilities: source.audiencePermissions.map((entry) => entry.capability), membershipIds: source.audienceMemberships.map((entry) => entry.membershipId) });
                await cloneNorthPanelContent(tx, userId, organizationId, source.id, result.id);
            }
            await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_RESOURCE_CLONED", targetType: `North${input.kind}`, targetId: result.id, metadata: { sourceId: input.sourceId } });
            return result;
        });
    },
    reorder(userId, organizationId, kind, parentId, ids) {
        return transaction(async (tx) => {
            if (new Set(ids).size !== ids.length)
                fail(422, "INVALID_REORDER", "Resource IDs must be unique");
            if (kind === "CATEGORY") {
                await authorizeNorth(tx, userId, "north.category.update", { organizationId, scope: "ORGANIZATION" });
                const found = await tx.northCategory.count({ where: { organizationId, id: { in: ids } } });
                if (found !== ids.length)
                    fail(404, "NOT_FOUND", "Resource not found");
                await repo.reorderCategories(tx, organizationId, ids);
            }
            else if (kind === "SUBCATEGORY" && parentId) {
                await authorizeNorth(tx, userId, "north.subcategory.update", await categoryTarget(tx, organizationId, parentId));
                const found = await tx.northSubcategory.count({ where: { organizationId, categoryId: parentId, id: { in: ids } } });
                if (found !== ids.length)
                    fail(404, "NOT_FOUND", "Resource not found");
                await repo.reorderSubcategories(tx, parentId, ids);
            }
            else if (kind === "PANEL" && parentId) {
                await authorizeNorth(tx, userId, "north.panel.update", await subcategoryTarget(tx, organizationId, parentId));
                const found = await tx.northPanel.count({ where: { organizationId, subcategoryId: parentId, id: { in: ids } } });
                if (found !== ids.length)
                    fail(404, "NOT_FOUND", "Resource not found");
                await repo.reorderPanels(tx, parentId, ids);
            }
            else
                fail(422, "INVALID_REORDER", "Parent is required");
            await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_RESOURCES_REORDERED", metadata: { kind, parentId: parentId ?? null, ids } });
            return { updated: ids.length };
        });
    },
    setAudience(userId, organizationId, panelId, input) {
        return transaction(async (tx) => {
            const target = await panelTarget(tx, organizationId, panelId);
            await authorizeNorth(tx, userId, "north.panel.update", target);
            const roles = input.roles ?? [], groupIds = input.groupIds ?? [], capabilities = input.capabilities ?? [], membershipIds = input.membershipIds ?? [];
            if (capabilities.some((item) => !isNorthCapability(item)))
                fail(422, "UNKNOWN_CAPABILITY", "Audience capability is not registered");
            if (groupIds.length !== await tx.organizationGroup.count({ where: { organizationId, id: { in: groupIds } } }))
                fail(422, "CROSS_TENANT_RESOURCE", "Audience group is outside the organization");
            if (membershipIds.length !== await tx.membership.count({ where: { organizationId, id: { in: membershipIds } } }))
                fail(422, "CROSS_TENANT_RESOURCE", "Audience member is outside the organization");
            const expected = input.type === "ROLES" ? roles.length : input.type === "GROUPS" ? groupIds.length : input.type === "PERMISSIONS" ? capabilities.length : input.type === "SPECIFIC_USERS" ? membershipIds.length : 1;
            if (input.type !== "ALL_MEMBERS" && expected === 0)
                fail(422, "AUDIENCE_EMPTY", "Audience requires at least one selector");
            await repo.replaceAudience(tx, { id: panelId, organizationId }, { type: input.type, roles, groupIds, capabilities, membershipIds });
            await audit.append(tx, { actorId: userId, organizationId, action: "PANEL_UPDATED", targetType: "NorthPanel", targetId: panelId, metadata: { field: "audience", type: input.type } });
            return repo.panel(tx, organizationId, panelId);
        });
    },
    audience(userId, organizationId, panelId) {
        return transaction(async (tx) => {
            const target = await panelTarget(tx, organizationId, panelId);
            await authorizeNorth(tx, userId, "north.panel.update", target);
            const audience = await repo.panelAudience(tx, organizationId, panelId);
            if (!audience)
                fail(404, "NOT_FOUND", "Panel not found");
            return {
                type: audience.audienceType,
                roles: audience.audienceRoles.map(({ role }) => role).sort(),
                groupIds: audience.audienceGroups.map(({ groupId }) => groupId).sort(),
                capabilities: audience.audiencePermissions.map(({ capability }) => capability).sort(),
                membershipIds: audience.audienceMemberships.map(({ membershipId }) => membershipId).sort(),
            };
        });
    },
    navigation(userId, organizationId) {
        return transaction(async (tx) => {
            const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
            if (!membership)
                fail(404, "NOT_FOUND", "Organization not found");
            const categories = await repo.navigation(tx, organizationId);
            const result = [];
            for (const category of categories) {
                const subcategories = [];
                for (const subcategory of category.subcategories) {
                    const panels = [];
                    for (const panel of subcategory.panels) {
                        const target = { organizationId, scope: "PANEL", categoryId: category.id, subcategoryId: subcategory.id, panelId: panel.id };
                        if (await hasNorthCapability(tx, userId, "north.panel.read", target) && await audienceAllows(tx, userId, panel))
                            panels.push({ id: panel.id, name: panel.name, icon: panel.icon, slug: panel.slug, status: panel.status });
                    }
                    if (panels.length)
                        subcategories.push({ id: subcategory.id, name: subcategory.name, icon: subcategory.icon, slug: subcategory.slug, panels });
                }
                if (subcategories.length)
                    result.push({ id: category.id, name: category.name, icon: category.icon, color: category.color, slug: category.slug, subcategories });
            }
            return result;
        });
    },
    resolve(userId, slugs) {
        return transaction(async (tx) => {
            const organization = await tx.organization.findFirst({ where: { slug: slugs.organizationSlug, status: "ACTIVE" } });
            if (!organization)
                fail(404, "NOT_FOUND", "Content not found");
            const category = await repo.categoryBySlug(tx, organization.id, slugs.categorySlug);
            if (!category || category.status !== "ACTIVE")
                fail(404, "NOT_FOUND", "Content not found");
            const subcategory = await repo.subcategoryBySlug(tx, category.id, slugs.subcategorySlug);
            if (!subcategory || subcategory.status !== "ACTIVE")
                fail(404, "NOT_FOUND", "Content not found");
            const panel = await repo.panelBySlug(tx, subcategory.id, slugs.panelSlug);
            if (!panel || panel.status !== "PUBLISHED")
                fail(404, "NOT_FOUND", "Content not found");
            const target = { organizationId: organization.id, scope: "PANEL", categoryId: category.id, subcategoryId: subcategory.id, panelId: panel.id };
            if (!(await hasNorthCapability(tx, userId, "north.panel.read", target)) || !(await audienceAllows(tx, userId, panel)))
                fail(404, "NOT_FOUND", "Content not found");
            const revision = panel.resourceKind === "CONTENT" ? await northContent.publishedForResolve(tx, userId, organization.id, panel.id, slugs.locale) : null;
            return { organization: { name: organization.name, slug: organization.slug }, category: { id: category.id, name: category.name, slug: category.slug }, subcategory: { id: subcategory.id, name: subcategory.name, slug: subcategory.slug }, panel: { id: panel.id, name: panel.name, description: panel.description, icon: panel.icon, slug: panel.slug, status: panel.status }, revision, canonicalPath: `/${organization.slug}/${category.slug}/${subcategory.slug}/${panel.slug}` };
        });
    },
    setHome(userId, organizationId, panelId) {
        return transaction(async (tx) => { await authorizeNorth(tx, userId, "north.category.update", { organizationId, scope: "ORGANIZATION" }); if (panelId) {
            const panel = await repo.panel(tx, organizationId, panelId);
            if (!panel || panel.status !== "PUBLISHED")
                fail(422, "HOME_PANEL_INVALID", "Home panel must be published in this organization");
            if (!(await audienceAllows(tx, userId, await repo.panelBySlug(tx, panel.subcategoryId, panel.slug))))
                fail(422, "HOME_PANEL_INVALID", "Home panel is not authorized for the actor");
        } await tx.organization.update({ where: { id: organizationId }, data: { homePanelId: panelId } }); await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_HOME_PANEL_UPDATED", targetType: "Organization", targetId: organizationId, metadata: { panelId } }); return { homePanelId: panelId }; });
    },
};
async function grantTarget(tx, organizationId, input) {
    if (input.scope === "PLATFORM")
        fail(403, "PRIVILEGE_ESCALATION", "Tenant grants cannot target platform scope");
    if (input.scope === "ORGANIZATION") {
        if (input.resourceId)
            fail(422, "GRANT_SCOPE_INVALID", "Organization grants do not use a resource ID");
        return { organizationId, scope: "ORGANIZATION" };
    }
    if (!input.resourceId)
        fail(422, "GRANT_SCOPE_INVALID", "Scoped grant requires a resource ID");
    if (input.scope === "CATEGORY")
        return categoryTarget(tx, organizationId, input.resourceId);
    if (input.scope === "SUBCATEGORY")
        return subcategoryTarget(tx, organizationId, input.resourceId);
    return panelTarget(tx, organizationId, input.resourceId);
}
export const northPermissions = {
    list(userId, organizationId) { return transaction(async (tx) => { await authorizeNorth(tx, userId, "north.permission.read", { organizationId, scope: "ORGANIZATION" }); const [roles, groups, memberships] = await repo.scopedGrants(tx, organizationId); return { roles, groups, memberships }; }); },
    subjects(userId, organizationId) {
        return transaction(async (tx) => {
            if (!(await repo.membership(tx, organizationId, userId)))
                fail(404, "NOT_FOUND", "Organization not found");
            await authorizeNorth(tx, userId, "north.permission.read", {
                organizationId,
                scope: "ORGANIZATION",
            });
            const [groups, memberships] = await repo.permissionSubjects(tx, organizationId);
            return {
                roles: ["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"],
                groups,
                memberships: memberships
                    .map(({ user, ...membership }) => ({ ...membership, name: user.name }))
                    .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? "") || left.id.localeCompare(right.id)),
            };
        });
    },
    grant(userId, organizationId, input) {
        return transaction(async (tx) => {
            await authorizeNorth(tx, userId, "north.permission.manage", { organizationId, scope: "ORGANIZATION" });
            const target = await grantTarget(tx, organizationId, input);
            await requireGrantAuthority(tx, userId, input.capability, target);
            const resource = { categoryId: target.scope === "CATEGORY" ? target.categoryId : undefined, subcategoryId: target.scope === "SUBCATEGORY" ? target.subcategoryId : undefined, panelId: target.scope === "PANEL" ? target.panelId : undefined };
            let grant;
            try {
                if (input.subjectType === "ROLE" && input.role)
                    grant = await repo.grantRole(tx, { organizationId, role: input.role, capability: input.capability, scope: input.scope, ...resource });
                else if (input.subjectType === "GROUP" && input.groupId) {
                    if (!(await tx.organizationGroup.findFirst({ where: { id: input.groupId, organizationId } })))
                        fail(422, "CROSS_TENANT_RESOURCE", "Group is outside the organization");
                    grant = await repo.grantGroup(tx, { organizationId, groupId: input.groupId, capability: input.capability, scope: input.scope, ...resource });
                }
                else if (input.subjectType === "MEMBERSHIP" && input.membershipId) {
                    if (!(await tx.membership.findFirst({ where: { id: input.membershipId, organizationId } })))
                        fail(422, "CROSS_TENANT_RESOURCE", "Membership is outside the organization");
                    grant = await repo.grantMembership(tx, { organizationId, membershipId: input.membershipId, capability: input.capability, scope: input.scope, ...resource });
                }
                else
                    fail(422, "GRANT_SUBJECT_INVALID", "Grant subject does not match its type");
            }
            catch (error) {
                conflict(error);
            }
            await audit.append(tx, { actorId: userId, organizationId, action: "PERMISSION_GRANTED", targetType: `North${input.subjectType}Grant`, targetId: grant.id, metadata: { capability: input.capability, scope: input.scope, resourceId: input.resourceId ?? null } });
            return grant;
        });
    },
    revoke(userId, organizationId, id) { return transaction(async (tx) => { await authorizeNorth(tx, userId, "north.permission.manage", { organizationId, scope: "ORGANIZATION" }); const [role, group, direct] = await Promise.all([tx.northRoleGrant.findFirst({ where: { id, organizationId } }), tx.northGroupGrant.findFirst({ where: { id, organizationId } }), tx.northMembershipGrant.findFirst({ where: { id, organizationId } })]); const grant = role ?? group ?? direct; if (!grant)
        fail(404, "NOT_FOUND", "Grant not found"); const target = await grantTarget(tx, organizationId, { subjectType: role ? "ROLE" : group ? "GROUP" : "MEMBERSHIP", capability: grant.capability, scope: grant.scope, resourceId: grant.categoryId ?? grant.subcategoryId ?? grant.panelId ?? undefined }); await requireGrantAuthority(tx, userId, grant.capability, target); await repo.revokeGrant(tx, organizationId, id); await audit.append(tx, { actorId: userId, organizationId, action: "PERMISSION_REVOKED", targetType: "NorthGrant", targetId: id, metadata: { capability: grant.capability } }); return null; }); },
};
export const northPlatformPermissions = {
    list(actorId, targetUserId) {
        return transaction(async (tx) => {
            const actor = await tx.user.findUnique({ where: { id: actorId } });
            if (!actor || actor.role !== "SUPERADMIN" || actor.status !== "ACTIVE")
                fail(403, "FORBIDDEN", "Superadmin permission required");
            const target = await tx.user.findUnique({ where: { id: targetUserId } });
            if (!target)
                fail(404, "NOT_FOUND", "User not found");
            return tx.northPlatformGrant.findMany({ where: { userId: targetUserId }, orderBy: { capability: "asc" } });
        });
    },
    grant(actorId, targetUserId, capability) {
        return transaction(async (tx) => {
            const actor = await tx.user.findUnique({ where: { id: actorId } });
            if (!actor || actor.role !== "SUPERADMIN" || actor.status !== "ACTIVE")
                fail(403, "FORBIDDEN", "Superadmin permission required");
            const target = await tx.user.findUnique({ where: { id: targetUserId } });
            if (!target)
                fail(404, "NOT_FOUND", "User not found");
            if (target.role !== "ADMIN")
                fail(422, "PLATFORM_GRANT_TARGET_INVALID", "Global NORTH grants require an active GBP admin");
            const grant = await tx.northPlatformGrant.upsert({ where: { userId_capability: { userId: targetUserId, capability } }, create: { userId: targetUserId, capability }, update: {} });
            await audit.append(tx, { actorId, action: "PERMISSION_GRANTED", targetType: "NorthPlatformGrant", targetId: targetUserId, metadata: { capability } });
            return grant;
        });
    },
    revoke(actorId, targetUserId, capability) {
        return transaction(async (tx) => {
            const actor = await tx.user.findUnique({ where: { id: actorId } });
            if (!actor || actor.role !== "SUPERADMIN" || actor.status !== "ACTIVE")
                fail(403, "FORBIDDEN", "Superadmin permission required");
            await tx.northPlatformGrant.deleteMany({ where: { userId: targetUserId, capability } });
            await audit.append(tx, { actorId, action: "PERMISSION_REVOKED", targetType: "NorthPlatformGrant", targetId: targetUserId, metadata: { capability } });
            return null;
        });
    },
};
