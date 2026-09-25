import { prisma, } from "../../lib/database.js";
export const tenantRepository = {
    membership(tx, organizationId, userId) {
        return tx.membership.findUnique({
            where: { organizationId_userId: { organizationId, userId } },
        });
    },
    organization(tx, id) {
        return tx.organization.findUnique({ where: { id } });
    },
    organizationBySlug(tx, slug) {
        return tx.organization.findUnique({ where: { slug } });
    },
    publicOrganization(slug) {
        return prisma.organization.findFirst({
            where: { slug, status: "ACTIVE" },
            select: { name: true, slug: true },
        });
    },
    list(userId) {
        return prisma.organization.findMany({
            where: { memberships: { some: { userId } } },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
    },
    create(tx, userId, data) {
        return tx.organization.create({
            data: {
                ...data,
                memberships: { create: { userId, role: "OWNER" } },
                billingProfile: { create: {} },
            },
        });
    },
    update(tx, id, data) {
        return tx.organization.update({ where: { id }, data });
    },
    members(tx, organizationId) {
        return tx.membership.findMany({
            where: { organizationId },
            take: 100,
            orderBy: { createdAt: "asc" },
        });
    },
    owners(tx, organizationId) {
        return tx.membership.count({ where: { organizationId, role: "OWNER" } });
    },
    setRole(tx, id, role) {
        return tx.membership.update({ where: { id }, data: { role } });
    },
    remove(tx, id) {
        return tx.membership.delete({ where: { id } });
    },
    revokePendingEmailInvitations(tx, organizationId, email) {
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
    invite(tx, data) {
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
    invitations(tx, organizationId) {
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
    invitation(tx, tokenHashes) {
        return tx.invitation.findFirst({
            where: { tokenHash: { in: tokenHashes } },
            include: {
                groupGrants: { select: { groupId: true } },
                permissionGrants: { select: { permission: true } },
            },
        });
    },
    invitationById(tx, id, organizationId) {
        return tx.invitation.findFirst({
            where: { id, organizationId },
            include: {
                groupGrants: { select: { groupId: true } },
                permissionGrants: { select: { permission: true } },
            },
        });
    },
    revoke(tx, id) {
        return tx.invitation.update({
            where: { id },
            data: { revokedAt: new Date() },
        });
    },
    async accept(tx, id, organizationId, userId, role) {
        const consumed = await tx.invitation.updateMany({
            where: { id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
            data: { acceptedAt: new Date(), acceptedByUserId: userId },
        });
        if (consumed.count !== 1)
            return null;
        // Existing members never gain a new role by replaying an old invitation.
        const membership = await tx.membership.upsert({
            where: { organizationId_userId: { organizationId, userId } },
            create: { organizationId, userId, role },
            update: {},
        });
        return membership;
    },
    addInvitationGrants(tx, organizationId, membershipId, groupIds, permissions) {
        return Promise.all([
            ...groupIds.map((groupId) => tx.organizationGroupMember.upsert({
                where: { groupId_membershipId: { groupId, membershipId } },
                create: { organizationId, groupId, membershipId },
                update: {},
            })),
            ...permissions.map((permission) => tx.membershipPermissionGrant.upsert({
                where: { membershipId_permission: { membershipId, permission } },
                create: { organizationId, membershipId, permission },
                update: {},
            })),
        ]);
    },
};
