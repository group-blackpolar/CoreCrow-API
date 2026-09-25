import type { NorthPermissionScope, TenantRole } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import {
  isNorthCapability,
  northTenantCapabilities,
  type NorthCapability,
} from "../authorization/policy.js";

export type NorthTarget = {
  organizationId: string;
  scope: Exclude<NorthPermissionScope, "PLATFORM">;
  categoryId?: string;
  subcategoryId?: string;
  panelId?: string;
};

type StoredGrant = {
  capability: string;
  scope: NorthPermissionScope;
  categoryId: string | null;
  subcategoryId: string | null;
  panelId: string | null;
};

const baseTenantRoles = new Set<TenantRole>(["OWNER", "ADMIN"]);

function grantCovers(grant: StoredGrant, target: NorthTarget) {
  if (grant.scope === "ORGANIZATION") return true;
  if (grant.scope === "CATEGORY") return grant.categoryId === target.categoryId;
  if (grant.scope === "SUBCATEGORY")
    return grant.subcategoryId === target.subcategoryId;
  if (grant.scope === "PANEL") return grant.panelId === target.panelId;
  return false;
}

async function platformCapabilities(tx: Transaction, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, northPlatformGrants: { select: { capability: true } } },
  });
  if (!user || user.status !== "ACTIVE") return { role: undefined, grants: new Set<string>() };
  return {
    role: user.role,
    grants: new Set(user.northPlatformGrants.map((entry) => entry.capability)),
  };
}

export async function hasNorthCapability(
  tx: Transaction,
  userId: string,
  capability: NorthCapability,
  target: NorthTarget,
) {
  if (!isNorthCapability(capability)) return false;
  const platform = await platformCapabilities(tx, userId);
  if (platform.role === "SUPERADMIN") return true;
  if (
    platform.grants.has("north.organization.manage_all") ||
    (platform.grants.has("north.content.manage_all_tenants") &&
      capability !== "north.permission.manage" && capability !== "north.permission.read")
  ) return true;

  const membership = await tx.membership.findUnique({
    where: { organizationId_userId: { organizationId: target.organizationId, userId } },
  });
  if (!membership) return false;
  if (baseTenantRoles.has(membership.role) && northTenantCapabilities.includes(capability))
    return true;
  const [role, group, direct] = await Promise.all([
    tx.northRoleGrant.findMany({
      where: { organizationId: target.organizationId, role: membership.role, capability },
    }),
    tx.northGroupGrant.findMany({
      where: {
        organizationId: target.organizationId,
        capability,
        group: { memberships: { some: { membershipId: membership.id } } },
      },
    }),
    tx.northMembershipGrant.findMany({
      where: { organizationId: target.organizationId, membershipId: membership.id, capability },
    }),
  ]);
  return [...role, ...group, ...direct].some((grant) => grantCovers(grant, target));
}

export async function authorizeNorth(
  tx: Transaction,
  userId: string,
  capability: NorthCapability,
  target: NorthTarget,
) {
  const organization = await tx.organization.findUnique({ where: { id: target.organizationId } });
  if (!organization) fail(404, "NOT_FOUND", "Resource not found");
  if (organization.status !== "ACTIVE")
    fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
  if (!(await hasNorthCapability(tx, userId, capability, target)))
    fail(403, "FORBIDDEN", "Permission denied");
}

export async function requireGrantAuthority(
  tx: Transaction,
  userId: string,
  capability: string,
  target: NorthTarget,
) {
  if (!isNorthCapability(capability))
    fail(422, "UNKNOWN_CAPABILITY", "Capability is not registered");
  if (!(await hasNorthCapability(tx, userId, capability, target)))
    fail(403, "PRIVILEGE_ESCALATION", "Cannot grant a capability or scope you do not possess");
}
