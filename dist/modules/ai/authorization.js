import { resolvePermissions } from "../authorization/service.js";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
/** AI tenant authorization is intentionally membership-first and never reads global roles or platform grants. */
export async function resolveAITenantContextIn(tx, userId, organizationId) {
    const organization = await tx.organization.findUnique({ where: { id: organizationId } });
    if (!organization)
        fail(404, "NOT_FOUND", "Organization not found");
    if (organization.status !== "ACTIVE")
        fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
    const resolved = await resolvePermissions(tx, userId, organizationId);
    return { organization, ...resolved };
}
export function resolveAITenantContext(userId, organizationId) {
    return transaction((tx) => resolveAITenantContextIn(tx, userId, organizationId));
}
export async function authorizeAI(userId, organizationId, required) {
    const context = await resolveAITenantContext(userId, organizationId);
    if (required.some((permission) => !context.permissions.includes(permission)))
        fail(403, "AI_PERMISSION_DENIED", "AI capability is not authorized");
    return context;
}
