import type { TenantRole } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";

export const DEFAULT_ROLES = ["VIEWER", "MEMBER", "BILLING_ADMIN"] as const satisfies readonly TenantRole[];
export type OrganizationPolicyView = { defaultMemberRole: (typeof DEFAULT_ROLES)[number]; defaultGroupIds: string[]; importRetentionDays: number | null };

/** Defaults applied when an invitation or new account does not choose a role or groups. Callers inside a transaction use this directly. */
export async function readOrganizationPolicy(tx: Transaction, organizationId: string): Promise<OrganizationPolicyView> {
  const row = await tx.organizationPolicy.findUnique({ where: { organizationId }, include: { defaultGroups: { select: { groupId: true } } } });
  return {
    defaultMemberRole: (row?.defaultMemberRole as OrganizationPolicyView["defaultMemberRole"] | undefined) ?? "MEMBER",
    defaultGroupIds: (row?.defaultGroups ?? []).map((entry) => entry.groupId).sort(),
    importRetentionDays: row?.importRetentionDays ?? null,
  };
}

export const organizationPolicy = {
  get(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "organization.read");
      return readOrganizationPolicy(tx, organizationId);
    });
  },
  /** Changing defaults decides what new accounts can reach, so it needs both organization.update and permissions.manage. */
  set(userId: string, organizationId: string, input: OrganizationPolicyView) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "organization.update");
      await authorize(tx, userId, organizationId, "permissions.manage");
      const groupIds = [...new Set(input.defaultGroupIds)];
      const found = await tx.organizationGroup.count({ where: { organizationId, id: { in: groupIds } } });
      if (found !== groupIds.length) fail(422, "CROSS_TENANT_RESOURCE", "A default group is outside the organization");
      await tx.organizationPolicy.upsert({
        where: { organizationId },
        create: { organizationId, defaultMemberRole: input.defaultMemberRole, importRetentionDays: input.importRetentionDays, updatedBy: userId },
        update: { defaultMemberRole: input.defaultMemberRole, importRetentionDays: input.importRetentionDays, updatedBy: userId },
      });
      await tx.organizationPolicyGroup.deleteMany({ where: { organizationId } });
      if (groupIds.length) await tx.organizationPolicyGroup.createMany({ data: groupIds.map((groupId) => ({ organizationId, groupId })) });
      await audit.append(tx, {
        actorId: userId, organizationId, action: "organization.policy.update", targetType: "organization", targetId: organizationId,
        metadata: { defaultMemberRole: input.defaultMemberRole, defaultGroups: groupIds.length, importRetentionDays: input.importRetentionDays },
      });
      return readOrganizationPolicy(tx, organizationId);
    });
  },
};
