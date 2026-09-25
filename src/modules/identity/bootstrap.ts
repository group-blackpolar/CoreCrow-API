import { prisma } from "../../lib/database.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { fail } from "../../shared/errors.js";
import { hashPassword } from "better-auth/crypto";
import { credentials } from "./credential-repository.js";

export async function bootstrapOperator(
  email: string,
  adminSecret: string,
  temporaryPassword: string,
) {
  const normalizedEmail = email.trim().toLowerCase();
  const [adminSecretHash, temporaryPasswordHash] = await Promise.all([
    hashPassword(adminSecret),
    hashPassword(temporaryPassword),
  ]);
  return transaction(async (tx) => {
    const user = await credentials.bootstrapIdentity(tx, normalizedEmail);
    if (!user?.emailVerified)
      fail(
        409,
        "VERIFIED_IDENTITY_REQUIRED",
        "Register and verify this identity through Better Auth first",
      );
    const accounts = await credentials.credentialAccounts(tx, user.id);
    if (accounts.length > 1)
      fail(
        409,
        "CREDENTIAL_STATE_INVALID",
        "The identity has multiple credential accounts",
      );
    const otherSuperadmin = await credentials.otherSuperadmin(tx, user.id);
    if (otherSuperadmin && user.role !== "SUPERADMIN")
      fail(
        409,
        "ALREADY_INITIALIZED",
        "A different superadmin already exists; use authenticated role management",
      );
    if (accounts[0])
      await credentials.updateCredential(
        tx,
        accounts[0].id,
        temporaryPasswordHash,
      );
    else
      await credentials.createCredential(tx, user.id, temporaryPasswordHash);
    await credentials.configureOperator(tx, user.id, adminSecretHash);
    await credentials.revokeAllSessions(tx, user.id);
    await auditRepository.append(tx, {
      actorId: user.id,
      action: user.role === "SUPERADMIN"
        ? "identity.operator.recover"
        : "identity.operator.bootstrap",
      targetType: "User",
      targetId: user.id,
    });
    await auditRepository.append(tx, {
      actorId: user.id,
      action: "identity.credential.temporary.issue",
      targetType: "User",
      targetId: user.id,
    });
    return { id: user.id, credentialCreated: accounts.length === 0 };
  });
}
export const closeBootstrap = () => prisma.$disconnect();
