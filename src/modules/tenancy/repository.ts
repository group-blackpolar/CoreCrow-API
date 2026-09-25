import {
  prisma,
  type InvitationKind,
  type OrganizationStatus,
  type TenantRole,
} from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
export const tenantRepository = {
  membership(tx: Transaction, organizationId: string, userId: string) {
    return tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  },
  organization(tx: Transaction, id: string) {
    return tx.organization.findUnique({ where: { id } });
  },
  organizationBySlug(tx: Transaction, slug: string) {
    return tx.organization.findUnique({ where: { slug } });
  },
  publicOrganization(slug: string) {
    return prisma.organization.findFirst({
      where: { slug, status: "ACTIVE" },
      select: { name: true, slug: true },
    });
  },
  list(userId: string) {
    return prisma.organization.findMany({
      where: { memberships: { some: { userId } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  },
  create(
    tx: Transaction,
    userId: string,
    data: { name: string; slug: string; storageLimitBytes?: bigint },
  ) {
    return tx.organization.create({
      data: {
        ...data,
        memberships: { create: { userId, role: "OWNER" } },
        billingProfile: { create: {} },
      },
    });
  },
  update(
    tx: Transaction,
    id: string,
    data: { name?: string; slug?: string; status?: OrganizationStatus },
  ) {
    return tx.organization.update({ where: { id }, data });
  },
  members(tx: Transaction, organizationId: string) {
    return tx.membership.findMany({
      where: { organizationId },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
  },
  owners(tx: Transaction, organizationId: string) {
    return tx.membership.count({ where: { organizationId, role: "OWNER" } });
  },
  setRole(tx: Transaction, id: string, role: TenantRole) {
    return tx.membership.update({ where: { id }, data: { role } });
  },
  remove(tx: Transaction, id: string) {
    return tx.membership.delete({ where: { id } });
  },
  revokePendingEmailInvitations(
    tx: Transaction,
    organizationId: string,
    email: string,
  ) {
    return tx.invitation.updateMany({
      where: {
        organizationId,
        kind: "EMAIL",
        email,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  },
  invite(
    tx: Transaction,
    data: {
      organizationId: string;
      kind: InvitationKind;
      email?: string;
      role: TenantRole;
      tokenHash: string;
      expiresAt: Date;
      groupIds: string[];
      permissions: string[];
    },
  ) {
    const { groupIds, permissions, ...invitation } = data;
    return tx.invitation.create({ data: invitation }).then(async (created) => {
      if (groupIds.length)
        await tx.invitationGroupGrant.createMany({
          data: groupIds.map((groupId) => ({
            invitationId: created.id,
            organizationId: data.organizationId,
            groupId,
          })),
        });
      if (permissions.length)
        await tx.invitationPermissionGrant.createMany({
          data: permissions.map((permission) => ({
            invitationId: created.id,
            organizationId: data.organizationId,
            permission,
          })),
        });
      return tx.invitation.findUniqueOrThrow({
        where: { id: created.id },
      include: {
        groupGrants: { select: { groupId: true } },
        permissionGrants: { select: { permission: true } },
      },
      });
    });
  },
  invitations(tx: Transaction, organizationId: string) {
    return tx.invitation.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      include: {
        groupGrants: { select: { groupId: true } },
        permissionGrants: { select: { permission: true } },
      },
    });
  },
  invitation(tx: Transaction, tokenHashes: string[]) {
    return tx.invitation.findFirst({
      where: { tokenHash: { in: tokenHashes } },
      include: {
        groupGrants: { select: { groupId: true } },
        permissionGrants: { select: { permission: true } },
      },
    });
  },
  invitationById(tx: Transaction, id: string, organizationId: string) {
    return tx.invitation.findFirst({
      where: { id, organizationId },
      include: {
        groupGrants: { select: { groupId: true } },
        permissionGrants: { select: { permission: true } },
      },
    });
  },
  revoke(tx: Transaction, id: string) {
    return tx.invitation.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  },
  async accept(
    tx: Transaction,
    id: string,
    organizationId: string,
    userId: string,
    role: TenantRole,
  ) {
    const consumed = await tx.invitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedByUserId: userId },
    });
    if (consumed.count !== 1) return null;
    // Existing members never gain a new role by replaying an old invitation.
    const membership = await tx.membership.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: { organizationId, userId, role },
      update: {},
    });
    return membership;
  },
  addInvitationGrants(
    tx: Transaction,
    organizationId: string,
    membershipId: string,
    groupIds: string[],
    permissions: string[],
  ) {
    return Promise.all([
      ...groupIds.map((groupId) =>
        tx.organizationGroupMember.upsert({
          where: { groupId_membershipId: { groupId, membershipId } },
          create: { organizationId, groupId, membershipId },
          update: {},
        }),
      ),
      ...permissions.map((permission) =>
        tx.membershipPermissionGrant.upsert({
          where: { membershipId_permission: { membershipId, permission } },
          create: { organizationId, membershipId, permission },
          update: {},
        }),
      ),
    ]);
  },
};
