import { tenantRepository } from "../tenancy/repository.js";
import { effectivePermissions, type Permission } from "./policy.js";
import { fail } from "../../shared/errors.js";
import type { Transaction } from "../../shared/transaction.js";
import { authorizationRepository } from "./repository.js";
import { currentInspection } from "../../shared/request-context.js";
import { inspectionPermissions } from "./inspection.js";

export async function resolvePermissions(
  tx: Transaction,
  userId: string,
  organizationId: string,
) {
  const member = await tenantRepository.membership(tx, organizationId, userId);
  if (!member) {
    const inspection = currentInspection();
    if (inspection?.userId === userId && inspection.organizationId === organizationId)
      return {
        member: { id: "platform-inspection", organizationId, userId, role: "VIEWER" as const, createdAt: new Date(0) },
        permissions: inspectionPermissions,
        inspection: true as const,
      };
    fail(404, "NOT_FOUND", "Organization not found");
  }
  const [groupGrants, directGrants] = await Promise.all([
    authorizationRepository.groupGrants(tx, organizationId, member.id),
    authorizationRepository.directGrants(tx, organizationId, member.id),
  ]);
  return {
    inspection: false as const,
    member,
    permissions: effectivePermissions(
      member.role,
      groupGrants.map((grant) => grant.permission),
      directGrants.map((grant) => grant.permission),
    ),
  };
}

export async function authorize(
  tx: Transaction,
  userId: string,
  organizationId: string,
  permission: Permission,
) {
  const resolved = await resolvePermissions(tx, userId, organizationId);
  const organization = await tenantRepository.organization(tx, organizationId);
  if (!organization) fail(404, "NOT_FOUND", "Organization not found");
  // Platform inspection may read suspended or archived organizations; it can never write.
  if (!resolved.inspection && organization.status === "SUSPENDED")
    fail(403, "ORGANIZATION_SUSPENDED", "Organization is suspended");
  if (
    !resolved.inspection &&
    organization.status === "ARCHIVED" &&
    permission !== "organization.read" &&
    permission !== "organization.update"
  )
    fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
  if (!resolved.permissions.includes(permission))
    fail(403, "FORBIDDEN", "Permission denied");
  return resolved.member;
}
