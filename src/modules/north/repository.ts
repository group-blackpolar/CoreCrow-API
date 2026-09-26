import type {
  NorthAudienceType,
  NorthCategoryClass,
  NorthPanelStatus,
  NorthPermissionScope,
  NorthResourceKind,
  NorthResourceStatus,
  TenantRole,
} from "../../lib/database.js";
import { Prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";

export type Localized = Record<string, string>;
export type MetadataInput = {
  name?: Localized;
  description?: Localized | null;
  icon?: string | null;
  color?: string | null;
  slug?: string;
  order?: number;
  navigationHidden?: boolean;
};

export const northRepository = {
  membership(tx: Transaction, organizationId: string, userId: string) {
    return tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  },
  category(tx: Transaction, organizationId: string, id: string) {
    return tx.northCategory.findFirst({ where: { id, organizationId } });
  },
  subcategory(tx: Transaction, organizationId: string, id: string) {
    return tx.northSubcategory.findFirst({ where: { id, organizationId } });
  },
  panel(tx: Transaction, organizationId: string, id: string) {
    return tx.northPanel.findFirst({ where: { id, organizationId } });
  },
  panelAudience(tx: Transaction, organizationId: string, id: string) {
    return tx.northPanel.findFirst({
      where: { id, organizationId },
      select: {
        audienceType: true,
        audienceRoles: { select: { role: true } },
        audienceGroups: { select: { groupId: true } },
        audiencePermissions: { select: { capability: true } },
        audienceMemberships: { select: { membershipId: true } },
      },
    });
  },
  categoryBySlug(tx: Transaction, organizationId: string, slug: string) {
    return tx.northCategory.findFirst({
      where: {
        organizationId,
        OR: [{ slug }, { aliases: { some: { slug } } }],
      },
    });
  },
  subcategoryBySlug(tx: Transaction, categoryId: string, slug: string) {
    return tx.northSubcategory.findFirst({
      where: { categoryId, OR: [{ slug }, { aliases: { some: { slug } } }] },
    });
  },
  panelBySlug(tx: Transaction, subcategoryId: string, slug: string) {
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
  navigation(tx: Transaction, organizationId: string) {
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
  managementTree(tx: Transaction, organizationId: string) {
    return tx.northCategory.findMany({
      where: { organizationId },
      orderBy: [{ order: "asc" }, { id: "asc" }],
      include: {
        subcategories: {
          where: { organizationId },
          orderBy: [{ order: "asc" }, { id: "asc" }],
          include: {
            panels: {
              where: { organizationId },
              orderBy: [{ order: "asc" }, { id: "asc" }],
            },
          },
        },
      },
    });
  },
  createCategory(tx: Transaction, organizationId: string, data: {
    resourceKind: NorthResourceKind;
    categoryClass: NorthCategoryClass;
    name: Localized;
    description?: Localized | null;
    icon?: string | null;
    color?: string | null;
    slug: string;
    order?: number;
    navigationHidden?: boolean;
    sourceTemplateId?: string;
    sourceTemplateVersion?: number;
  }) {
    const description = data.description === null ? Prisma.DbNull : data.description;
    return tx.northCategory.create({
      data: { organizationId, scope: "ORGANIZATION", ...data, description },
    });
  },
  updateCategory(tx: Transaction, id: string, data: MetadataInput & { status?: NorthResourceStatus }) {
    return tx.northCategory.update({ where: { id }, data: { ...data, ...(data.description === null ? { description: Prisma.DbNull } : {}) } as Prisma.NorthCategoryUncheckedUpdateInput });
  },
  aliasCategory(tx: Transaction, organizationId: string, categoryId: string, slug: string) {
    return tx.northCategorySlugAlias.upsert({
      where: { organizationId_slug: { organizationId, slug } },
      create: { organizationId, categoryId, slug }, update: {},
    });
  },
  createSubcategory(tx: Transaction, organizationId: string, categoryId: string, data: {
    resourceKind: NorthResourceKind; name: Localized; description?: Localized | null;
    icon?: string | null; color?: string | null; slug: string; order?: number; navigationHidden?: boolean;
  }) {
    return tx.northSubcategory.create({ data: { organizationId, categoryId, ...data, description: data.description === null ? Prisma.DbNull : data.description } });
  },
  updateSubcategory(tx: Transaction, id: string, data: MetadataInput & { categoryId?: string; status?: NorthResourceStatus }) {
    return tx.northSubcategory.update({ where: { id }, data: { ...data, ...(data.description === null ? { description: Prisma.DbNull } : {}) } as Prisma.NorthSubcategoryUncheckedUpdateInput });
  },
  aliasSubcategory(tx: Transaction, categoryId: string, subcategoryId: string, slug: string) {
    return tx.northSubcategorySlugAlias.upsert({
      where: { categoryId_slug: { categoryId, slug } },
      create: { categoryId, subcategoryId, slug }, update: {},
    });
  },
  createPanel(tx: Transaction, organizationId: string, subcategoryId: string, data: {
    resourceKind: NorthResourceKind; name: Localized; description?: Localized | null;
    icon?: string | null; color?: string | null; slug: string; order?: number; navigationHidden?: boolean;
    audienceType?: NorthAudienceType;
  }) {
    return tx.northPanel.create({ data: { organizationId, subcategoryId, ...data, description: data.description === null ? Prisma.DbNull : data.description } });
  },
  updatePanel(tx: Transaction, id: string, data: MetadataInput & {
    subcategoryId?: string; status?: NorthPanelStatus; audienceType?: NorthAudienceType;
  }) {
    return tx.northPanel.update({ where: { id }, data: { ...data, ...(data.description === null ? { description: Prisma.DbNull } : {}) } as Prisma.NorthPanelUncheckedUpdateInput });
  },
  aliasPanel(tx: Transaction, subcategoryId: string, panelId: string, slug: string) {
    return tx.northPanelSlugAlias.upsert({
      where: { subcategoryId_slug: { subcategoryId, slug } },
      create: { subcategoryId, panelId, slug }, update: {},
    });
  },
  reorderCategories(tx: Transaction, organizationId: string, ids: string[]) {
    return Promise.all(ids.map((id, order) => tx.northCategory.updateMany({ where: { id, organizationId }, data: { order } })));
  },
  reorderSubcategories(tx: Transaction, categoryId: string, ids: string[]) {
    return Promise.all(ids.map((id, order) => tx.northSubcategory.updateMany({ where: { id, categoryId }, data: { order } })));
  },
  reorderPanels(tx: Transaction, subcategoryId: string, ids: string[]) {
    return Promise.all(ids.map((id, order) => tx.northPanel.updateMany({ where: { id, subcategoryId }, data: { order } })));
  },
  async replaceAudience(tx: Transaction, panel: { id: string; organizationId: string }, input: {
    type: NorthAudienceType; roles: TenantRole[]; groupIds: string[]; capabilities: string[]; membershipIds: string[];
  }) {
    await Promise.all([
      tx.northPanelAudienceRole.deleteMany({ where: { panelId: panel.id } }),
      tx.northPanelAudienceGroup.deleteMany({ where: { panelId: panel.id } }),
      tx.northPanelAudiencePermission.deleteMany({ where: { panelId: panel.id } }),
      tx.northPanelAudienceMembership.deleteMany({ where: { panelId: panel.id } }),
    ]);
    await tx.northPanel.update({ where: { id: panel.id }, data: { audienceType: input.type } });
    if (input.roles.length) await tx.northPanelAudienceRole.createMany({ data: input.roles.map((role) => ({ organizationId: panel.organizationId, panelId: panel.id, role })) });
    if (input.groupIds.length) await tx.northPanelAudienceGroup.createMany({ data: input.groupIds.map((groupId) => ({ organizationId: panel.organizationId, panelId: panel.id, groupId })) });
    if (input.capabilities.length) await tx.northPanelAudiencePermission.createMany({ data: input.capabilities.map((capability) => ({ organizationId: panel.organizationId, panelId: panel.id, capability })) });
    if (input.membershipIds.length) await tx.northPanelAudienceMembership.createMany({ data: input.membershipIds.map((membershipId) => ({ organizationId: panel.organizationId, panelId: panel.id, membershipId })) });
  },
  scopedGrants(tx: Transaction, organizationId: string) {
    return Promise.all([
      tx.northRoleGrant.findMany({ where: { organizationId } }),
      tx.northGroupGrant.findMany({ where: { organizationId } }),
      tx.northMembershipGrant.findMany({ where: { organizationId } }),
    ]);
  },
  permissionSubjects(tx: Transaction, organizationId: string) {
    return Promise.all([
      tx.organizationGroup.findMany({
        where: { organizationId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true },
      }),
      tx.membership.findMany({
        where: { organizationId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          user: { select: { name: true } },
        },
      }),
    ]);
  },
  grantRole(tx: Transaction, data: { organizationId: string; role: TenantRole; capability: string; scope: NorthPermissionScope; categoryId?: string; subcategoryId?: string; panelId?: string }) {
    return tx.northRoleGrant.create({ data });
  },
  grantGroup(tx: Transaction, data: { organizationId: string; groupId: string; capability: string; scope: NorthPermissionScope; categoryId?: string; subcategoryId?: string; panelId?: string }) {
    return tx.northGroupGrant.create({ data });
  },
  grantMembership(tx: Transaction, data: { organizationId: string; membershipId: string; capability: string; scope: NorthPermissionScope; categoryId?: string; subcategoryId?: string; panelId?: string }) {
    return tx.northMembershipGrant.create({ data });
  },
  revokeGrant(tx: Transaction, organizationId: string, id: string) {
    return Promise.all([
      tx.northRoleGrant.deleteMany({ where: { id, organizationId } }),
      tx.northGroupGrant.deleteMany({ where: { id, organizationId } }),
      tx.northMembershipGrant.deleteMany({ where: { id, organizationId } }),
    ]);
  },
};
