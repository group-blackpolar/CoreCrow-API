import { randomBytes } from "node:crypto";
import { keys } from "./repository.js";
import { hash } from "./crypto.js";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { auditRepository } from "../audit/repository.js";
export const keyScopes = ["organizations:read", "commerce:read"] as const;
export const security = {
  list: keys.list,
  create(actorId: string, data: { name: string; scopes: string[] }) {
    return transaction(async (tx) => {
      if (
        data.scopes.some(
          (scope) => !keyScopes.includes(scope as (typeof keyScopes)[number]),
        )
      )
        fail(400, "INVALID_SCOPE", "Unsupported key scope");
      const token = `bp_${randomBytes(32).toString("hex")}`;
      const result = await keys.create(tx, {
        userId: actorId,
        ...data,
        keyHash: hash(token),
        prefix: token.slice(0, 10),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      });
      await auditRepository.append(tx, {
        actorId,
        action: "apikey.create",
        targetId: result.id,
      });
      return { ...result, token };
    });
  },
  revoke(actorId: string, id: string) {
    return transaction(async (tx) => {
      const key = await keys.findOwned(tx, id, actorId);
      if (!key) fail(404, "NOT_FOUND", "Key not found");
      if (key.revokedAt) return key;
      const result = await keys.revoke(tx, id);
      await auditRepository.append(tx, {
        actorId,
        action: "apikey.revoke",
        targetId: id,
      });
      return result;
    });
  },
};
