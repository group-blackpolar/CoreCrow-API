import { randomBytes, randomInt } from "node:crypto";
import { hashPassword, makeSignature, verifyPassword } from "better-auth/crypto";
import { auth } from "../../lib/auth.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { adminSecrets } from "./admin-secret-repository.js";
import { credentials } from "./credential-repository.js";
import { requireOperator } from "./service.js";
import { fail } from "../../shared/errors.js";
import { AuidCryptoError, auidEncryptionAvailable, decryptAuid, encryptAuid } from "./auid-crypto.js";
import { consumeActorAttempt } from "../../shared/actor-rate-limit.js";

// Perform the same password-grade work for unknown identities and identities
// without a secret so the credential check does not become an account oracle.
const dummyHash = hashPassword("corecrow-non-credential-dummy-value");

export async function authenticateAdminSecret(
  email: string,
  secret: string,
  ipAddress: string,
) {
  const user = await adminSecrets.findByEmail(email.trim().toLowerCase());
  const storedHash = user?.adminSecretHash ?? (await dummyHash);
  let matches = false;
  try {
    matches = await verifyPassword({ hash: storedHash, password: secret });
  } catch {
    // A damaged stored hash fails closed and is repaired only through bootstrap.
  }
  if (
    !matches ||
    !user?.adminSecretHash ||
    user.status !== "ACTIVE" ||
    !user.emailVerified ||
    !["ADMIN", "SUPERADMIN"].includes(user.role)
  )
    return null;

  const context = await auth.$context;
  const sessionToken = randomBytes(32).toString("hex");
  const session = await transaction(async (tx) => {
    const current = await adminSecrets.authenticationState(tx, user.id);
    if (
      !current?.emailVerified ||
      current.status !== "ACTIVE" ||
      current.adminSecretHash !== storedHash ||
      !["ADMIN", "SUPERADMIN"].includes(current.role)
    )
      return null;
    const created = await adminSecrets.createSession(
      tx,
      user.id,
      sessionToken,
      ipAddress,
      new Date(Date.now() + 12 * 60 * 60_000),
    );
    await auditRepository.append(tx, {
      actorId: user.id,
      action: "identity.session.create",
      targetType: "Session",
      targetId: created.id,
    });
    await auditRepository.append(tx, {
      actorId: user.id,
      action: "identity.admin-secret.signin",
      targetType: "Session",
      targetId: created.id,
    });
    return created;
  });
  if (!session) return null;
  const signedSessionToken = `${session.token}.${await makeSignature(session.token, context.secret)}`;
  return {
    user,
    session,
    signedSessionToken,
    sessionCookie: context.authCookies.sessionToken,
  };
}

const AUID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const newAuid = () =>
  `AUID-${Array.from({ length: 24 }, () => AUID_ALPHABET[randomInt(AUID_ALPHABET.length)]).join("")}`;

async function reauthenticate(actorId: string, password: string) {
  const state = await credentials.passwordState(actorId);
  const hash = state?.accounts.length === 1 ? state.accounts[0]?.password : null;
  let ok = false;
  try {
    ok = Boolean(hash) && (await verifyPassword({ hash: hash!, password }));
  } catch {
    // damaged hash fails closed
  }
  if (!ok) fail(401, "REAUTHENTICATION_FAILED", "The password is incorrect");
}

/** Privileged attempts that fail are audited too (never with passwords or secrets). */
async function denied(actorId: string, targetId: string, action: string, reason: string, ip: string) {
  await transaction((tx) =>
    auditRepository.append(tx, { actorId, action, targetType: "User", targetId, metadata: { reason, ip } }),
  );
}

async function requireSuperadmin(actorId: string, targetId: string, action: string, ip: string) {
  try {
    await requireOperator(actorId, true);
  } catch (error) {
    await denied(actorId, targetId, action, "forbidden", ip);
    throw error;
  }
}

async function reauthenticateAudited(actorId: string, targetId: string, action: string, password: string, ip: string) {
  try {
    await reauthenticate(actorId, password);
  } catch (error) {
    await denied(actorId, targetId, action, "reauthentication_failed", ip);
    throw error;
  }
}

/** Whether a user has an AUID and whether it can be revealed. Never returns the credential. */
export async function auidState(actorId: string, targetId: string) {
  await requireOperator(actorId);
  const target = await adminSecrets.stateFor(targetId);
  if (!target) fail(404, "NOT_FOUND", "User not found");
  return {
    configured: Boolean(target.adminSecretHash),
    revealable: Boolean(target.adminSecretCiphertext),
    encryptionAvailable: auidEncryptionAvailable(),
    role: target.role,
  };
}

/**
 * SUPERADMIN-only. The actor re-enters their own account password (verified here, never stored or logged), then the
 * target's AUID is replaced: the previous one stops working immediately. Hash and (when the server key is
 * configured) AES-GCM ciphertext are written atomically. The new value is returned once. Audit never carries it.
 */
export async function regenerateAuid(
  actorId: string,
  targetId: string,
  password: string,
  ipAddress: string,
) {
  await requireSuperadmin(actorId, targetId, "admin.auid.regenerate_denied", ipAddress);
  consumeActorAttempt(actorId, "auid.regenerate");
  await reauthenticateAudited(actorId, targetId, "admin.auid.regenerate_denied", password, ipAddress);
  // Fail closed: never mint a credential that could not be revealed later. The previous AUID stays untouched.
  if (!auidEncryptionAvailable()) {
    await denied(actorId, targetId, "admin.auid.regenerate_denied", "encryption_unavailable", ipAddress);
    fail(503, "AUID_ENCRYPTION_UNAVAILABLE", "AUID management is temporarily unavailable");
  }
  // generate -> hash -> encrypt happen before the single transaction; the transaction writes hash + ciphertext
  // in one UPDATE, so no persisted state can pair a new hash with a missing or old ciphertext.
  const auid = newAuid();
  const adminSecretHash = await hashPassword(auid);
  const sealed = encryptAuid(targetId, auid);
  if (!sealed) fail(503, "AUID_ENCRYPTION_UNAVAILABLE", "AUID management is temporarily unavailable");
  return transaction(async (tx) => {
    const target = await adminSecrets.stateIn(tx, targetId);
    if (!target) fail(404, "NOT_FOUND", "User not found");
    if (!["ADMIN", "SUPERADMIN"].includes(target.role))
      fail(409, "NOT_AN_OPERATOR", "Only administrators have an AUID");
    await adminSecrets.setCredential(tx, targetId, adminSecretHash, sealed);
    await auditRepository.append(tx, {
      actorId,
      action: "admin.auid.regenerated",
      targetType: "User",
      targetId,
      metadata: { hadAuid: Boolean(target.adminSecretHash), ip: ipAddress },
    });
    return { auid };
  });
}

/** SUPERADMIN-only Reveal of a recoverable AUID after password re-authentication. */
export async function revealAuid(actorId: string, targetId: string, password: string, ipAddress: string) {
  await requireSuperadmin(actorId, targetId, "admin.auid.reveal_denied", ipAddress);
  consumeActorAttempt(actorId, "auid.reveal");
  await reauthenticateAudited(actorId, targetId, "admin.auid.reveal_denied", password, ipAddress);
  const target = await adminSecrets.stateFor(targetId);
  if (!target) fail(404, "NOT_FOUND", "User not found");
  if (!target.adminSecretCiphertext || !target.adminSecretEncryptionVersion)
    fail(409, "AUID_NOT_REVEALABLE", "Regenerate this AUID to enable Reveal");
  let auid: string;
  try {
    auid = decryptAuid(targetId, target.adminSecretCiphertext, target.adminSecretEncryptionVersion);
  } catch (error) {
    // Configuration problems and possible corruption/tampering are told apart in Audit only; the client gets nothing specific.
    const kind = error instanceof AuidCryptoError ? error.kind : "unexpected";
    await denied(actorId, targetId, "admin.auid.reveal_denied", kind === "key_unavailable" ? "key_unavailable" : `ciphertext_integrity:${kind}`, ipAddress);
    fail(503, "AUID_REVEAL_UNAVAILABLE", "The credential cannot be revealed right now");
  }
  await transaction((tx) =>
    auditRepository.append(tx, { actorId, action: "admin.auid.revealed", targetType: "User", targetId, metadata: { ip: ipAddress } }),
  );
  return { auid };
}
