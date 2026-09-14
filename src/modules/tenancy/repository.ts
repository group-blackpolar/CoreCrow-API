import { prisma, type TenantRole } from "../../lib/database.js";
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
    data: { name: string; slug: string },
  ) {
    return tx.organization.create({
      data: { ...data, memberships: { create: { userId, role: "OWNER" } } },
    });
  },
  update(tx: Transaction, id: string, name: string) {
    return tx.organization.update({ where: { id }, data: { name } });
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
  invite(
    tx: Transaction,
    data: {
      organizationId: string;
      email: string;
      role: TenantRole;
      tokenHash: string;
      expiresAt: Date;
    },
  ) {
    return tx.invitation.create({ data });
  },
  invitation(tx: Transaction, tokenHash: string) {
    return tx.invitation.findUnique({ where: { tokenHash } });
  },
  invitationById(tx: Transaction, id: string, organizationId: string) {
    return tx.invitation.findFirst({ where: { id, organizationId } });
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
