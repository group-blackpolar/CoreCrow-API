export const authorizationRepository = {
    directGrants(tx, organizationId, membershipId) {
        return tx.membershipPermissionGrant.findMany({
            where: { organizationId, membershipId },
            select: { permission: true },
        });
    },
    groupGrants(tx, organizationId, membershipId) {
        return tx.groupPermissionGrant.findMany({
            where: {
                organizationId,
                group: {
                    memberships: { some: { organizationId, membershipId } },
                },
            },
            select: { permission: true },
        });
    },
};
