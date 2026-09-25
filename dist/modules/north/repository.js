import { Prisma } from "../../lib/database.js";
export const northRepository = {
    category(tx, organizationId, id) {
        return tx.northCategory.findFirst({ where: { id, organizationId } });
    },
    subcategory(tx, organizationId, id) {
        return tx.northSubcategory.findFirst({ where: { id, organizationId } });
    },
    panel(tx, organizationId, id) {
        return tx.northPanel.findFirst({ where: { id, organizationId } });
    },
    categoryBySlug(tx, organizationId, slug) {
        return tx.northCategory.findFirst({
            where: {
                organizationId,
                OR: [{ slug }, { aliases: { some: { slug } } }],
            },
        });
    },
    subcategoryBySlug(tx, categoryId, slug) {
        return tx.northSubcategory.findFirst({
            where: { categoryId, OR: [{ slug }, { aliases: { some: { slug } } }] },
        });
    },
    panelBySlug(tx, subcategoryId, slug) {
        return tx.northPanel.findFirst({
            where: { subcategoryId, OR: [{ slug }, { aliases: { some: { slug } } }] },
            include: {
                audienceRoles: true,
                audienceGroups: true,
                audiencePermissions: true,
                audienceMemberships: true,
            },
        });
    },
    navigation(tx, organizationId) {
        return tx.northCategory.findMany({
            where: { organizationId, status: "ACTIVE", navigationHidden: false },
            orderBy: [{ order: "asc" }, { id: "asc" }],
            include: {
                subcategories: {
                    where: { status: "ACTIVE", navigationHidden: false },
                    orderBy: [{ order: "asc" }, { id: "asc" }],
                    include: {
                        panels: {
                            // Navigation is a reader surface. Draft metadata is available only
                            // through the explicit, authorized management endpoints.
                            where: { status: "PUBLISHED", navigationHidden: false },
                            orderBy: [{ order: "asc" }, { id: "asc" }],
                            include: {
                                audienceRoles: true,
                                audienceGroups: true,
                                audiencePermissions: true,
                                audienceMemberships: true,
                            },
                        },
                    },
                },
            },
        });
    },
    createCategory(tx, organizationId, data) {
        const description = data.description === null ? Prisma.DbNull : data.description;
        return tx.northCategory.create({
            data: { organizationId, scope: "ORGANIZATION", ...data, description },
        });
    },
    updateCategory(tx, id, data) {
        return tx.northCategory.update({ where: { id }, data: { ...data, ...(data.description === null ? { description: Prisma.DbNull } : {}) } });
    },
    aliasCategory(tx, organizationId, categoryId, slug) {
        return tx.northCategorySlugAlias.upsert({
            where: { organizationId_slug: { organizationId, slug } },
            create: { organizationId, categoryId, slug }, update: {},
        });
    },
    createSubcategory(tx, organizationId, categoryId, data) {
        return tx.northSubcategory.create({ data: { organizationId, categoryId, ...data, description: data.description === null ? Prisma.DbNull : data.description } });
    },
    updateSubcategory(tx, id, data) {
        return tx.northSubcategory.update({ where: { id }, data: { ...data, ...(data.description === null ? { description: Prisma.DbNull } : {}) } });
    },
    aliasSubcategory(tx, categoryId, subcategoryId, slug) {
        return tx.northSubcategorySlugAlias.upsert({
            where: { categoryId_slug: { categoryId, slug } },
            create: { categoryId, subcategoryId, slug }, update: {},
        });
    },
    createPanel(tx, organizationId, subcategoryId, data) {
        return tx.northPanel.create({ data: { organizationId, subcategoryId, ...data, description: data.description === null ? Prisma.DbNull : data.description } });
    },
    updatePanel(tx, id, data) {
        return tx.northPanel.update({ where: { id }, data: { ...data, ...(data.description === null ? { description: Prisma.DbNull } : {}) } });
    },
    aliasPanel(tx, subcategoryId, panelId, slug) {
        return tx.northPanelSlugAlias.upsert({
            where: { subcategoryId_slug: { subcategoryId, slug } },
            create: { subcategoryId, panelId, slug }, update: {},
        });
    },
    reorderCategories(tx, organizationId, ids) {
        return Promise.all(ids.map((id, order) => tx.northCategory.updateMany({ where: { id, organizationId }, data: { order } })));
    },
    reorderSubcategories(tx, categoryId, ids) {
        return Promise.all(ids.map((id, order) => tx.northSubcategory.updateMany({ where: { id, categoryId }, data: { order } })));
    },
    reorderPanels(tx, subcategoryId, ids) {
        return Promise.all(ids.map((id, order) => tx.northPanel.updateMany({ where: { id, subcategoryId }, data: { order } })));
    },
    async replaceAudience(tx, panel, input) {
        await Promise.all([
            tx.northPanelAudienceRole.deleteMany({ where: { panelId: panel.id } }),
            tx.northPanelAudienceGroup.deleteMany({ where: { panelId: panel.id } }),
            tx.northPanelAudiencePermission.deleteMany({ where: { panelId: panel.id } }),
            tx.northPanelAudienceMembership.deleteMany({ where: { panelId: panel.id } }),
        ]);
        await tx.northPanel.update({ where: { id: panel.id }, data: { audienceType: input.type } });
        if (input.roles.length)
            await tx.northPanelAudienceRole.createMany({ data: input.roles.map((role) => ({ organizationId: panel.organizationId, panelId: panel.id, role })) });
        if (input.groupIds.length)
            await tx.northPanelAudienceGroup.createMany({ data: input.groupIds.map((groupId) => ({ organizationId: panel.organizationId, panelId: panel.id, groupId })) });
        if (input.capabilities.length)
            await tx.northPanelAudiencePermission.createMany({ data: input.capabilities.map((capability) => ({ organizationId: panel.organizationId, panelId: panel.id, capability })) });
        if (input.membershipIds.length)
            await tx.northPanelAudienceMembership.createMany({ data: input.membershipIds.map((membershipId) => ({ organizationId: panel.organizationId, panelId: panel.id, membershipId })) });
    },
    scopedGrants(tx, organizationId) {
        return Promise.all([
            tx.northRoleGrant.findMany({ where: { organizationId } }),
            tx.northGroupGrant.findMany({ where: { organizationId } }),
            tx.northMembershipGrant.findMany({ where: { organizationId } }),
        ]);
    },
    grantRole(tx, data) {
        return tx.northRoleGrant.create({ data });
    },
    grantGroup(tx, data) {
        return tx.northGroupGrant.create({ data });
    },
    grantMembership(tx, data) {
        return tx.northMembershipGrant.create({ data });
    },
    revokeGrant(tx, organizationId, id) {
        return Promise.all([
            tx.northRoleGrant.deleteMany({ where: { id, organizationId } }),
            tx.northGroupGrant.deleteMany({ where: { id, organizationId } }),
            tx.northMembershipGrant.deleteMany({ where: { id, organizationId } }),
        ]);
    },
};
