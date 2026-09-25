export const groupsRepository = {
    list(tx, organizationId) {
        return tx.organizationGroup.findMany({
            where: { organizationId },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: 100,
            include: {
                permissionGrants: { select: { permission: true } },
                memberships: {
                    select: { membership: { select: { userId: true } } },
                },
            },
        });
    },
    group(tx, organizationId, id) {
        return tx.organizationGroup.findFirst({ where: { id, organizationId } });
    },
    named(tx, organizationId, name) {
        return tx.organizationGroup.findUnique({
            where: { organizationId_name: { organizationId, name } },
        });
    },
    create(tx, organizationId, data) {
        return tx.organizationGroup.create({ data: { organizationId, ...data } });
    },
    update(tx, id, data) {
        return tx.organizationGroup.update({ where: { id }, data });
    },
    remove(tx, id) {
        return tx.organizationGroup.delete({ where: { id } });
    },
    addMember(tx, organizationId, groupId, membershipId) {
        return tx.organizationGroupMember.upsert({
            where: { groupId_membershipId: { groupId, membershipId } },
            create: { organizationId, groupId, membershipId },
            update: {},
        });
    },
    removeMember(tx, groupId, membershipId) {
        return tx.organizationGroupMember.deleteMany({
            where: { groupId, membershipId },
        });
    },
    grantGroup(tx, organizationId, groupId, permission) {
        return tx.groupPermissionGrant.upsert({
            where: { groupId_permission: { groupId, permission } },
            create: { organizationId, groupId, permission },
            update: {},
        });
    },
    revokeGroup(tx, groupId, permission) {
        return tx.groupPermissionGrant.deleteMany({ where: { groupId, permission } });
    },
    directGrants(tx, organizationId, membershipId) {
        return tx.membershipPermissionGrant.findMany({
            where: { organizationId, membershipId },
            orderBy: { permission: "asc" },
            select: { permission: true },
        });
    },
    grantDirect(tx, organizationId, membershipId, permission) {
        return tx.membershipPermissionGrant.upsert({
            where: { membershipId_permission: { membershipId, permission } },
            create: { organizationId, membershipId, permission },
            update: {},
        });
    },
    revokeDirect(tx, membershipId, permission) {
        return tx.membershipPermissionGrant.deleteMany({
            where: { membershipId, permission },
        });
    },
};
