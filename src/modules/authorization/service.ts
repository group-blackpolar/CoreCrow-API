import { tenantRepository } from "../tenancy/repository.js";
import { allows, type Permission } from "./policy.js";
import { fail } from "../../shared/errors.js";
import type { Transaction } from "../../shared/transaction.js";
export async function authorize(
  tx: Transaction,
  userId: string,
  organizationId: string,
  permission: Permission,
) {
  const member = await tenantRepository.membership(tx, organizationId, userId);
  if (!member) fail(404, "NOT_FOUND", "Organization not found");
  if (!allows(member.role, permission))
    fail(403, "FORBIDDEN", "Permission denied");
  return member;
}
