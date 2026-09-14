import { prisma } from "../../lib/database.js";
export const tenantRepository = {
    membership(tx, organizationId, userId) {
        return tx.membership.findUnique({
            where: { organizationId_userId: { organizationId, userId } },
        });
    },
    organization(tx, id) {
        return tx.organization.findUnique({ where: { id } });
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
            data: { ...data, memberships: { create: { userId, role: "OWNER" } } },
        });
    },
    update(tx, id, name) {
        return tx.organization.update({ where: { id }, data: { name } });
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
    invite(tx, data) {
        return tx.invitation.create({ data });
    },
    invitation(tx, tokenHash) {
        return tx.invitation.findUnique({ where: { tokenHash } });
    },
    invitationById(tx, id, organizationId) {
        return tx.invitation.findFirst({ where: { id, organizationId } });
    },
    revoke(tx, id) {
        return tx.invitation.update({
            where: { id },
            data: { revokedAt: new Date() },
        });
    },
    async accept(tx, id, organizationId, userId, role) {
        await tx.invitation.update({
            where: { id },
            data: { acceptedAt: new Date() },
        });
        // Existing members never gain a new role by replaying an old invitation.
        return tx.membership.upsert({
            where: { organizationId_userId: { organizationId, userId } },
            create: { organizationId, userId, role },
            update: {},
        });
    },
};
