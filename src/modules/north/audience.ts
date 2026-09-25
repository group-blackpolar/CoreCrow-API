import type { NorthAudienceType, TenantRole } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import { isNorthCapability } from "../authorization/policy.js";
import { hasNorthCapability } from "./authorization.js";

type AudiencePanel = {
  id: string;
  organizationId: string;
  subcategoryId: string;
  audienceType: NorthAudienceType;
  audienceRoles: Array<{ role: TenantRole }>;
  audienceGroups: Array<{ groupId: string }>;
  audiencePermissions: Array<{ capability: string }>;
  audienceMemberships: Array<{ membershipId: string }>;
};

export async function northPanelAudienceAllows(
  tx: Transaction,
  userId: string,
  panel: AudiencePanel,
  categoryId: string,
) {
  const membership = await tx.membership.findUnique({
    where: { organizationId_userId: { organizationId: panel.organizationId, userId } },
  });
  if (!membership) return false;
  if (panel.audienceType === "ALL_MEMBERS") return true;
  if (panel.audienceType === "ROLES") return panel.audienceRoles.some((item) => item.role === membership.role);
  if (panel.audienceType === "SPECIFIC_USERS") return panel.audienceMemberships.some((item) => item.membershipId === membership.id);
  if (panel.audienceType === "GROUPS") {
    const groupIds = panel.audienceGroups.map((item) => item.groupId);
    return Boolean(groupIds.length && await tx.organizationGroupMember.findFirst({
      where: { organizationId: panel.organizationId, membershipId: membership.id, groupId: { in: groupIds } },
    }));
  }
  const target = {
    organizationId: panel.organizationId,
    scope: "PANEL" as const,
    categoryId,
    subcategoryId: panel.subcategoryId,
    panelId: panel.id,
  };
  for (const item of panel.audiencePermissions)
    if (isNorthCapability(item.capability) && await hasNorthCapability(tx, userId, item.capability, target)) return true;
  return false;
}
