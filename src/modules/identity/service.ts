import { hashPassword } from "better-auth/crypto";
import type { Role } from "../../lib/database.js";
import { identities } from "./repository.js";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { auditRepository } from "../audit/repository.js";
import { tenantRepository } from "../tenancy/repository.js";
export async function requireOperator(id: string, superOnly = false) {
  const user = await identities.get(id);
  if (
    !user ||
    !(superOnly ? ["SUPERADMIN"] : ["ADMIN", "SUPERADMIN"]).includes(user.role)
  )
    fail(403, "FORBIDDEN", "Operator permission required");
  return user;
}
export const users = {
  async create(
    actorId: string,
    data: { name: string; email: string; password: string; role: Role },
  ) {
    await requireOperator(actorId, data.role !== "USER");
    const password = await hashPassword(data.password);
    return transaction(async (tx) => {
      const user = await identities.create(
        tx,
        { name: data.name, email: data.email.toLowerCase(), role: data.role },
        password,
      );
      await auditRepository.append(tx, {
        actorId,
        action: "user.create",
        targetId: user.id,
      });
      return user;
    });
  },
  async update(
    actorId: string,
    id: string,
    data: { name?: string; role?: Role },
  ) {
    if (data.role !== undefined) {
      await requireOperator(actorId, true);
      if (id === actorId)
        fail(409, "SELF_ROLE_CHANGE", "Cannot change your own global role");
    } else if (actorId !== id) await requireOperator(actorId);
    return transaction(async (tx) => {
      if (!(await identities.getIn(tx, id)))
        fail(404, "NOT_FOUND", "User not found");
      const user = await identities.update(tx, id, data);
      await auditRepository.append(tx, {
        actorId,
        action: data.role ? "user.role.update" : "user.update",
        targetId: id,
      });
      return user;
    });
  },
  async delete(actorId: string, id: string) {
    await requireOperator(actorId, true);
    if (id === actorId)
      fail(409, "SELF_DELETE", "Cannot delete yourself through this endpoint");
    // Membership removal is explicit and must preserve organization owners.
    if ((await tenantRepository.list(id)).length)
      fail(409, "MEMBERSHIPS_EXIST", "Remove organization memberships first");
    return transaction(async (tx) => {
      await identities.delete(tx, id);
      await auditRepository.append(tx, {
        actorId,
        action: "user.delete",
        targetId: id,
      });
    });
  },
};
