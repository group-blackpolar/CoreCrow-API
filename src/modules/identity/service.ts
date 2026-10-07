import { hashPassword } from "better-auth/crypto";
import { randomBytes } from "node:crypto";
import { Prisma, type Role } from "../../lib/database.js";
import { identities, publicUser } from "./repository.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { auditRepository } from "../audit/repository.js";
import { tenantRepository } from "../tenancy/repository.js";
import { sendPreprovisionedAccountMail } from "../security/mail.js";
import { issueEmailVerificationCode } from "./email-verification-service.js";
export const CURRENT_TERMS_VERSION = "2026-09-16";
export async function requireOperator(id: string, superOnly = false) {
  const user = await identities.get(id);
  if (
    !user ||
    user.status !== "ACTIVE" ||
    !(superOnly ? ["SUPERADMIN"] : ["ADMIN", "SUPERADMIN"]).includes(user.role)
  )
    fail(403, "FORBIDDEN", "Operator permission required");
  return user;
}
/** NORTH must never be left without an active SUPERADMIN (suspension of SUPERADMIN is blocked separately). */
export async function requireAnotherSuperadmin(tx: Transaction, excludingId: string) {
  const others = await tx.user.count({ where: { role: "SUPERADMIN", status: "ACTIVE", id: { not: excludingId } } });
  if (others < 1) fail(409, "LAST_SUPERADMIN", "The last SUPERADMIN cannot be removed or demoted");
}

export const users = {
  acceptTerms(actorId: string, version: string) {
    if (version !== CURRENT_TERMS_VERSION)
      fail(409, "TERMS_VERSION_OUTDATED", "A newer terms version is required");
    return transaction(async (tx) => {
      const current = await identities.getIn(tx, actorId);
      if (!current) fail(404, "NOT_FOUND", "User not found");
      if (
        current.termsVersion === version &&
        current.termsAcceptedAt !== null
      )
        return current;
      const acceptedAt = new Date();
      const user = await identities.acceptTerms(
        tx,
        actorId,
        version,
        acceptedAt,
      );
      await auditRepository.append(tx, {
        actorId,
        action: "identity.terms.accept",
        targetType: "TermsVersion",
        targetId: version,
      });
      return user;
    });
  },
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
  async preprovision(
    actorId: string,
    data: { name: string; email: string; role: Exclude<Role, "SUPERADMIN"> },
  ) {
    await requireOperator(actorId, data.role === "ADMIN");
    const temporaryPassword = `${randomBytes(18).toString("base64url")}!aA1`;
    const password = await hashPassword(temporaryPassword);
    const email = data.email.trim().toLowerCase();
    let user;
    try {
      user = await transaction(async (tx) => {
        const created = await identities.create(
          tx,
          {
            name: data.name,
            email,
            role: data.role,
            passwordChangeRequired: true,
          },
          password,
        );
        await auditRepository.append(tx, {
          actorId,
          action: "platform.user.preprovision",
          targetType: "User",
          targetId: created.id,
          metadata: { role: data.role },
        });
        await auditRepository.append(tx, {
          actorId,
          action: "identity.credential.temporary.issue",
          targetType: "User",
          targetId: created.id,
        });
        return created;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        fail(409, "IDENTITY_EXISTS", "An identity with this email already exists");
      throw error;
    }
    let delivery = "sent" as "sent" | "failed";
    try {
      await sendPreprovisionedAccountMail(email, temporaryPassword);
      await issueEmailVerificationCode(email);
    } catch {
      delivery = "failed";
    }
    return { user, delivery };
  },
  /**
   * Superadmin creates an account with a login identifier shaped like an email and a password they choose.
   * No verification mail is sent: the account is created already verified and can sign in immediately.
   * The password is only ever hashed (never audited, logged or returned). SUPERADMIN cannot be created here.
   */
  async createAssigned(
    actorId: string,
    data: {
      name: string;
      email: string;
      password: string;
      role: Exclude<Role, "SUPERADMIN">;
      passwordChangeRequired: boolean;
    },
  ) {
    await requireOperator(actorId, true);
    const email = data.email.trim().toLowerCase();
    const password = await hashPassword(data.password);
    try {
      return await transaction(async (tx) => {
        const created = await identities.create(
          tx,
          {
            name: data.name,
            email,
            role: data.role,
            passwordChangeRequired: data.passwordChangeRequired,
            emailVerified: true,
          },
          password,
        );
        await auditRepository.append(tx, {
          actorId,
          action: "platform.user.create",
          targetType: "User",
          targetId: created.id,
          metadata: {
            role: data.role,
            emailVerified: true,
            passwordChangeRequired: data.passwordChangeRequired,
          },
        });
        await auditRepository.append(tx, {
          actorId,
          action: "identity.credential.assigned",
          targetType: "User",
          targetId: created.id,
        });
        return created;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        fail(409, "IDENTITY_EXISTS", "An identity with this email already exists");
      throw error;
    }
  },
  /** Superadmin marks an account as verified (e.g. one that never received its code). Idempotent. */
  async verifyEmailByOperator(actorId: string, id: string) {
    await requireOperator(actorId, true);
    return transaction(async (tx) => {
      const current = await identities.getIn(tx, id);
      if (!current) fail(404, "NOT_FOUND", "User not found");
      if (current.emailVerified) return current;
      const user = await tx.user.update({
        where: { id },
        data: { emailVerified: true },
        select: publicUser,
      });
      await tx.emailVerificationChallenge.deleteMany({ where: { userId: id } });
      await auditRepository.append(tx, {
        actorId,
        action: "platform.user.verify_email",
        targetType: "User",
        targetId: id,
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
      const target = await identities.getIn(tx, id);
      if (!target) fail(404, "NOT_FOUND", "User not found");
      if (data.role && target.role === "SUPERADMIN" && data.role !== "SUPERADMIN")
        await requireAnotherSuperadmin(tx, id);
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
      const target = await identities.getIn(tx, id);
      if (target?.role === "SUPERADMIN") await requireAnotherSuperadmin(tx, id);
      await identities.delete(tx, id);
      await auditRepository.append(tx, {
        actorId,
        action: "user.delete",
        targetId: id,
      });
    });
  },
};
