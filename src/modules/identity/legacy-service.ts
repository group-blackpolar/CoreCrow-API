import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { hash } from "../security/crypto.js";
import { legacyIdentity as repo } from "./legacy-repository.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { fail } from "../../shared/errors.js";
import { prisma } from "../../lib/database.js";
const attempts = new Map<string, { count: number; until: number }>();
export function legacyEnabled() { return process.env.ENABLE_LEGACY_ADMIN_AUTH === "true"; }
export async function validateAdminUniqueId(email: string, adminUniqueId: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await repo.user(prisma, normalizedEmail);
  if (!user?.adminUniqueId || !user.emailVerified || !["ADMIN", "SUPERADMIN"].includes(user.role)) return null;
  const matches = timingSafeEqual(
    Buffer.from(hash(adminUniqueId)),
    Buffer.from(hash(user.adminUniqueId)),
  );
  return matches ? user : null;
}
export async function legacyLogin(email: string, credential: string, ip: string) {
  if (!legacyEnabled()) fail(410, "LEGACY_AUTH_DISABLED", "Use Better Auth at /v1/auth");
  email = email.trim().toLowerCase();
  const bucket = hash(email); const previous = attempts.get(bucket);
  if (previous && previous.until > Date.now() && previous.count >= 5) fail(429, "RATE_LIMITED", "Try again later");
  if (attempts.size >= 10000) { const oldest = attempts.keys().next().value; if (oldest) attempts.delete(oldest); }
  attempts.set(bucket, { count: previous && previous.until > Date.now() ? previous.count + 1 : 1, until: previous && previous.until > Date.now() ? previous.until : Date.now() + 15 * 60000 });
  const result = await transaction(async tx => {
    const user = await repo.user(tx, email);
    const matches = timingSafeEqual(Buffer.from(hash(credential)), Buffer.from(hash(user?.adminUniqueId ?? "disabled-credential")));
    if (!matches || !user?.adminUniqueId || !user.emailVerified || !["ADMIN", "SUPERADMIN"].includes(user.role)) fail(401, "UNAUTHENTICATED", "Invalid credentials");
    const token = randomBytes(32).toString("hex");
    const session = await repo.createSession(tx, user.id, hash(token), ip);
    await auditRepository.append(tx, { actorId: user.id, action: "identity.legacy.login", targetId: session.id });
    return { success: true, migrationRequired: true, session: { id: session.id, token, userId: user.id, expiresAt: session.expiresAt }, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
  attempts.delete(bucket); return result;
}
export async function legacyPrincipal(token: string) {
  if (!legacyEnabled()) fail(401, "UNAUTHENTICATED", "Use Better Auth");
  const session = await repo.session(hash(token));
  if (!session || session.expiresAt <= new Date() || !session.user.adminUniqueId || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) fail(401, "UNAUTHENTICATED", "Invalid legacy session");
  return { id: session.user.id, role: session.user.role };
}
export async function migrateLegacyIdentity(actorId: string, email: string, password: string) {
  if (!legacyEnabled()) fail(410, "LEGACY_AUTH_DISABLED", "Legacy migration is disabled");
  const hashed = await hashPassword(password);
  return transaction(async tx => {
    const user = await repo.user(tx, email.toLowerCase());
    if (!user || user.id !== actorId || !user.adminUniqueId || !user.emailVerified) fail(403, "FORBIDDEN", "Identity cannot be migrated");
    if (await repo.credential(tx, actorId)) fail(409, "CREDENTIAL_EXISTS", "Use the existing Better Auth credential");
    await repo.migrate(tx, actorId, hashed);
    await auditRepository.append(tx, { actorId, action: "identity.legacy.migrate", targetId: actorId });
    return { migrated: true };
  });
}
