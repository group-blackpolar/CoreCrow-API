import { hashPassword, verifyPassword } from "better-auth/crypto";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { auditRepository } from "../audit/repository.js";
import { credentials } from "./credential-repository.js";
async function matches(hash, password) {
    try {
        return await verifyPassword({ hash, password });
    }
    catch {
        return false;
    }
}
export async function changeTemporaryPassword(actorId, currentSessionId, currentPassword, newPassword) {
    const initial = await credentials.passwordState(actorId);
    if (!initial?.passwordChangeRequired)
        fail(409, "PASSWORD_CHANGE_NOT_REQUIRED", "A temporary password change is not required");
    const initialAccount = initial.accounts[0];
    if (initial.accounts.length !== 1 || !initialAccount?.password)
        fail(409, "CREDENTIAL_STATE_INVALID", "The credential account cannot be changed");
    const initialPasswordHash = initialAccount.password;
    if (!(await matches(initialPasswordHash, currentPassword)))
        fail(401, "INVALID_CURRENT_PASSWORD", "The current password is invalid");
    if (currentPassword === newPassword)
        fail(409, "PASSWORD_REUSE", "The new password must differ from the temporary password");
    const newPasswordHash = await hashPassword(newPassword);
    return transaction(async (tx) => {
        const current = await credentials.passwordStateIn(tx, actorId);
        if (!current?.passwordChangeRequired)
            fail(409, "PASSWORD_CHANGE_NOT_REQUIRED", "A temporary password change is not required");
        if (current.accounts.length !== 1 ||
            current.accounts[0]?.id !== initialAccount.id ||
            current.accounts[0]?.password !== initialPasswordHash)
            fail(409, "CREDENTIAL_CHANGED", "The credential changed; sign in again");
        if (!(await credentials.session(tx, currentSessionId, actorId)))
            fail(401, "SESSION_REQUIRED", "A current browser session is required");
        await credentials.updateCredential(tx, initialAccount.id, newPasswordHash);
        const user = await credentials.clearPasswordChangeRequired(tx, actorId);
        await credentials.revokeOtherSessions(tx, actorId, currentSessionId);
        await auditRepository.append(tx, {
            actorId,
            action: "identity.credential.temporary.complete",
            targetType: "User",
            targetId: actorId,
        });
        return user;
    });
}
