import { randomBytes } from "node:crypto";
import { hashPassword, makeSignature, verifyPassword } from "better-auth/crypto";
import { auth } from "../../lib/auth.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { adminSecrets } from "./admin-secret-repository.js";
// Perform the same password-grade work for unknown identities and identities
// without a secret so the credential check does not become an account oracle.
const dummyHash = hashPassword("corecrow-non-credential-dummy-value");
export async function authenticateAdminSecret(email, secret, ipAddress) {
    const user = await adminSecrets.findByEmail(email.trim().toLowerCase());
    const storedHash = user?.adminSecretHash ?? (await dummyHash);
    let matches = false;
    try {
        matches = await verifyPassword({ hash: storedHash, password: secret });
    }
    catch {
        // A damaged stored hash fails closed and is repaired only through bootstrap.
    }
    if (!matches ||
        !user?.adminSecretHash ||
        user.status !== "ACTIVE" ||
        !user.emailVerified ||
        !["ADMIN", "SUPERADMIN"].includes(user.role))
        return null;
    const context = await auth.$context;
    const sessionToken = randomBytes(32).toString("hex");
    const session = await transaction(async (tx) => {
        const current = await adminSecrets.authenticationState(tx, user.id);
        if (!current?.emailVerified ||
            current.status !== "ACTIVE" ||
            current.adminSecretHash !== storedHash ||
            !["ADMIN", "SUPERADMIN"].includes(current.role))
            return null;
        const created = await adminSecrets.createSession(tx, user.id, sessionToken, ipAddress, new Date(Date.now() + 12 * 60 * 60_000));
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
    if (!session)
        return null;
    const signedSessionToken = `${session.token}.${await makeSignature(session.token, context.secret)}`;
    return {
        user,
        session,
        signedSessionToken,
        sessionCookie: context.authCookies.sessionToken,
    };
}
