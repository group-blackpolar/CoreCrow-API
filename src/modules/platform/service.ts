import type { AccountStatus, OrganizationStatus, Role } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { requireOperator } from "../identity/service.js";
import { platformRepository as repo } from "./repository.js";

function page<T extends { id: string }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const visible = hasMore ? items.slice(0, limit) : items;
  return {
    items: visible,
    nextCursor: hasMore ? visible.at(-1)!.id : null,
  };
}

function organizationSummary<T extends {
  _count: { memberships: number; groups: number };
  billingProfile: { status: string; currency: string } | null;
}>(organization: T) {
  const { _count, billingProfile, ...base } = organization;
  return {
    ...base,
    memberCount: _count.memberships,
    groupCount: _count.groups,
    billingStatus: billingProfile?.status ?? null,
    billingCurrency: billingProfile?.currency ?? null,
  };
}

export const platform = {
  async users(actorId: string, query: { q?: string; limit: number; cursor?: string }) {
    await requireOperator(actorId);
    return transaction(async (tx) => page(await repo.users(tx, query), query.limit));
  },
  async user(actorId: string, id: string) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
      const user = await repo.user(tx, id);
      if (!user) fail(404, "NOT_FOUND", "User not found");
      return user;
    });
  },
  async organizations(
    actorId: string,
    query: { q?: string; limit: number; cursor?: string },
  ) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
      const result = page(await repo.organizations(tx, query), query.limit);
      return { ...result, items: result.items.map(organizationSummary) };
    });
  },
  async organization(actorId: string, id: string) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
      const organization = await repo.organization(tx, id);
      if (!organization) fail(404, "NOT_FOUND", "Organization not found");
      const { _count, billingProfile, groups, ...base } = organization;
      return {
        ...base,
        invitationCount: _count.invitations,
        groups: groups.map(({ _count: counts, ...group }) => ({
          ...group,
          memberCount: counts.memberships,
          permissionCount: counts.permissionGrants,
        })),
        billingProfile,
      };
    });
  },
  async setUserStatus(actorId: string, id: string, status: AccountStatus) {
    await requireOperator(actorId, true);
    if (actorId === id)
      fail(409, "SELF_SUSPENSION", "Cannot suspend or restore your own account");
    return transaction(async (tx) => {
      const target = await repo.user(tx, id);
      if (!target) fail(404, "NOT_FOUND", "User not found");
      if (target.role === "SUPERADMIN")
        fail(409, "SUPERADMIN_PROTECTED", "Superadmin suspension is not allowed here");
      const user = await repo.setUserStatus(tx, id, status);
      await repo.revokeSessions(tx, id);
      await audit.append(tx, {
        actorId,
        action: status === "SUSPENDED" ? "platform.user.suspend" : "platform.user.restore",
        targetType: "User",
        targetId: id,
        metadata: { previousStatus: target.status, status },
      });
      return user;
    });
  },
  async setOrganizationStatus(
    actorId: string,
    id: string,
    status: Extract<OrganizationStatus, "ACTIVE" | "SUSPENDED">,
  ) {
    await requireOperator(actorId, true);
    return transaction(async (tx) => {
      const target = await repo.organization(tx, id);
      if (!target) fail(404, "NOT_FOUND", "Organization not found");
      const organization = await repo.setOrganizationStatus(tx, id, status);
      await audit.append(tx, {
        actorId,
        organizationId: id,
        action:
          status === "SUSPENDED"
            ? "platform.organization.suspend"
            : "platform.organization.restore",
        targetType: "Organization",
        targetId: id,
        metadata: { previousStatus: target.status, status },
      });
      return organization;
    });
  },
};

export type PreprovisionRole = Exclude<Role, "SUPERADMIN">;
