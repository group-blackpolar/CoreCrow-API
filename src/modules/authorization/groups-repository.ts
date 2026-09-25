import type { Transaction } from "../../shared/transaction.js";

export const groupsRepository = {
  list(tx: Transaction, organizationId: string) {
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
  group(tx: Transaction, organizationId: string, id: string) {
    return tx.organizationGroup.findFirst({ where: { id, organizationId } });
  },
  named(tx: Transaction, organizationId: string, name: string) {
    return tx.organizationGroup.findUnique({
      where: { organizationId_name: { organizationId, name } },
    });
  },
  create(
    tx: Transaction,
    organizationId: string,
    data: { name: string; description?: string | null },
  ) {
    return tx.organizationGroup.create({ data: { organizationId, ...data } });
  },
  update(
    tx: Transaction,
    id: string,
    data: { name?: string; description?: string | null },
  ) {
    return tx.organizationGroup.update({ where: { id }, data });
  },
  remove(tx: Transaction, id: string) {
    return tx.organizationGroup.delete({ where: { id } });
  },
  addMember(
    tx: Transaction,
    organizationId: string,
    groupId: string,
    membershipId: string,
  ) {
    return tx.organizationGroupMember.upsert({
      where: { groupId_membershipId: { groupId, membershipId } },
      create: { organizationId, groupId, membershipId },
      update: {},
    });
  },
  removeMember(tx: Transaction, groupId: string, membershipId: string) {
    return tx.organizationGroupMember.deleteMany({
      where: { groupId, membershipId },
    });
  },
  grantGroup(
    tx: Transaction,
    organizationId: string,
    groupId: string,
    permission: string,
  ) {
    return tx.groupPermissionGrant.upsert({
      where: { groupId_permission: { groupId, permission } },
      create: { organizationId, groupId, permission },
      update: {},
    });
  },
  revokeGroup(tx: Transaction, groupId: string, permission: string) {
    return tx.groupPermissionGrant.deleteMany({ where: { groupId, permission } });
  },
  directGrants(
    tx: Transaction,
    organizationId: string,
    membershipId: string,
  ) {
    return tx.membershipPermissionGrant.findMany({
      where: { organizationId, membershipId },
      orderBy: { permission: "asc" },
      select: { permission: true },
    });
  },
  grantDirect(
    tx: Transaction,
    organizationId: string,
    membershipId: string,
    permission: string,
  ) {
    return tx.membershipPermissionGrant.upsert({
      where: { membershipId_permission: { membershipId, permission } },
      create: { organizationId, membershipId, permission },
      update: {},
    });
  },
  revokeDirect(tx: Transaction, membershipId: string, permission: string) {
    return tx.membershipPermissionGrant.deleteMany({
      where: { membershipId, permission },
    });
  },
};
