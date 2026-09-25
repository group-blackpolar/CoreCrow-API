import type { Transaction } from "../../shared/transaction.js";

export const authorizationRepository = {
  directGrants(
    tx: Transaction,
    organizationId: string,
    membershipId: string,
  ) {
    return tx.membershipPermissionGrant.findMany({
      where: { organizationId, membershipId },
      select: { permission: true },
    });
  },
  groupGrants(
    tx: Transaction,
    organizationId: string,
    membershipId: string,
  ) {
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
