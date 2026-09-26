import type { AccountStatus, OrganizationStatus, Role } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { requireOperator } from "../identity/service.js";
import { billingRepository } from "../billing/repository.js";
import { billingPolicy, estimateMonthlyMinor } from "../billing/service.js";
import { platformRepository as repo } from "./repository.js";

function page<T extends { id: string }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const visible = hasMore ? items.slice(0, limit) : items;
  return {
    items: visible,
    nextCursor: hasMore ? visible.at(-1)!.id : null,
  };
}

function organizationSummary<
  T extends {
    _count: { memberships: number; groups: number };
    billingProfile: { status: string; currency: string } | null;
    memberships: Array<{ user: { id: string; name: string | null; email: string } }>;
  },
>(organization: T) {
  const { _count, billingProfile, memberships, ...base } = organization;
  return {
    ...base,
    owner: memberships[0]?.user ?? null,
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
  /** Platform-wide aggregates for the administration dashboard.
   *
   * Reuses the billing repository and the shared monthly-estimate formula so
   * the dashboard cannot disagree with `/platform/billing/summary`. Storage
   * totals are `BigInt` columns and are serialized as strings on purpose: the
   * contract layer converts bigint values to `Number`, which would silently
   * lose precision for byte counters. */
  async summary(actorId: string) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const [
        userStatuses,
        verifiedUsers,
        usersCreatedLast7Days,
        usersCreatedLast30Days,
        organizationStatuses,
        organizationsCreatedLast30Days,
        membershipTotal,
        activeSessions,
        storage,
        billableOrganizationCount,
        billableMemberCount,
      ] = await Promise.all([
        repo.userStatusCounts(tx),
        repo.verifiedUserCount(tx),
        repo.usersCreatedSince(tx, sevenDaysAgo),
        repo.usersCreatedSince(tx, thirtyDaysAgo),
        repo.organizationStatusCounts(tx),
        repo.organizationsCreatedSince(tx, thirtyDaysAgo),
        repo.membershipCount(tx),
        repo.activeSessionCount(tx, now),
        repo.storageTotals(tx),
        billingRepository.eligibleProfileCount(tx),
        billingRepository.totalBillableMembers(tx),
      ]);
      const total = (rows: Array<{ _count: { _all: number } }>) =>
        rows.reduce((sum, row) => sum + row._count._all, 0);
      return {
        users: {
          total: total(userStatuses),
          active:
            userStatuses.find((row) => row.status === "ACTIVE")?._count._all ?? 0,
          suspended:
            userStatuses.find((row) => row.status === "SUSPENDED")?._count._all ??
            0,
          verified: verifiedUsers,
          createdLast7Days: usersCreatedLast7Days,
          createdLast30Days: usersCreatedLast30Days,
        },
        organizations: {
          total: total(organizationStatuses),
          active:
            organizationStatuses.find((row) => row.status === "ACTIVE")?._count
              ._all ?? 0,
          suspended:
            organizationStatuses.find((row) => row.status === "SUSPENDED")?._count
              ._all ?? 0,
          createdLast30Days: organizationsCreatedLast30Days,
        },
        memberships: { total: membershipTotal },
        sessions: { active: activeSessions },
        storage: {
          usedBytes: String(storage._sum.storageUsedBytes ?? 0n),
          limitBytes: String(storage._sum.storageLimitBytes ?? 0n),
          reservedBytes: String(storage._sum.storageReservedBytes ?? 0n),
        },
        billing: {
          currency: billingPolicy.currency,
          basePriceMinor: billingPolicy.basePriceMinor,
          memberPriceMinor: billingPolicy.memberPriceMinor,
          billableOrganizationCount,
          billableMemberCount,
          estimatedMonthlyMinor: estimateMonthlyMinor(
            billableOrganizationCount,
            billableMemberCount,
          ),
        },
        generatedAt: now.toISOString(),
      };
    });
  },
};

export type PreprovisionRole = Exclude<Role, "SUPERADMIN">;
