import { tenantRepository } from "../tenancy/repository.js";
import { allows } from "./policy.js";
import { fail } from "../../shared/errors.js";
export async function authorize(tx, userId, organizationId, permission) {
    const member = await tenantRepository.membership(tx, organizationId, userId);
    if (!member)
        fail(404, "NOT_FOUND", "Organization not found");
    if (!allows(member.role, permission))
        fail(403, "FORBIDDEN", "Permission denied");
    return member;
}
