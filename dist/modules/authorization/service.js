import { tenantRepository } from "../tenancy/repository.js";
import { effectivePermissions } from "./policy.js";
import { fail } from "../../shared/errors.js";
import { authorizationRepository } from "./repository.js";
export async function resolvePermissions(tx, userId, organizationId) {
    const member = await tenantRepository.membership(tx, organizationId, userId);
    if (!member)
        fail(404, "NOT_FOUND", "Organization not found");
    const [groupGrants, directGrants] = await Promise.all([
        authorizationRepository.groupGrants(tx, organizationId, member.id),
        authorizationRepository.directGrants(tx, organizationId, member.id),
    ]);
    return {
        member,
        permissions: effectivePermissions(member.role, groupGrants.map((grant) => grant.permission), directGrants.map((grant) => grant.permission)),
    };
}
export async function authorize(tx, userId, organizationId, permission) {
    const resolved = await resolvePermissions(tx, userId, organizationId);
    const organization = await tenantRepository.organization(tx, organizationId);
    if (!organization)
        fail(404, "NOT_FOUND", "Organization not found");
    if (organization.status === "SUSPENDED")
        fail(403, "ORGANIZATION_SUSPENDED", "Organization is suspended");
    if (organization.status === "ARCHIVED" &&
        permission !== "organization.read" &&
        permission !== "organization.update")
        fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
    if (!resolved.permissions.includes(permission))
        fail(403, "FORBIDDEN", "Permission denied");
    return resolved.member;
}
