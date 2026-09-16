import { randomBytes, timingSafeEqual } from "node:crypto";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { hash } from "../security/crypto.js";
import { auditRepository } from "../audit/repository.js";
import { desktopIdentityRepository as repo } from "./desktop-repository.js";
const REQUEST_PREFIX = "north-desktop-request:";
const CODE_PREFIX = "north-desktop-code:";
export const desktopIdentity = {
    authenticate(token) {
        return transaction(async (tx) => {
            const session = await repo.session(tx, token);
            if (!session || session.expiresAt <= new Date())
                fail(401, "UNAUTHENTICATED", "Desktop session unavailable");
            const user = await repo.user(tx, session.userId);
            if (!user || !user.emailVerified)
                fail(401, "UNAUTHENTICATED", "User unavailable");
            return user;
        });
    },
    start(nonce, challenge) {
        return transaction(async (tx) => {
            const identifier = `${REQUEST_PREFIX}${hash(nonce)}`;
            await repo.deleteVerification(tx, identifier);
            await repo.createVerification(tx, {
                identifier,
                value: challenge,
                expiresAt: new Date(Date.now() + 10 * 60_000),
            });
        });
    },
    pending(nonce) {
        return transaction((tx) => repo.verification(tx, `${REQUEST_PREFIX}${hash(nonce)}`));
    },
    complete(pending, userId, browserSessionId) {
        const code = randomBytes(32).toString("hex");
        return transaction(async (tx) => {
            await repo.deleteVerificationById(tx, pending.id);
            await repo.createVerification(tx, {
                identifier: `${CODE_PREFIX}${hash(code)}`,
                value: JSON.stringify({ userId, challenge: pending.value }),
                expiresAt: new Date(Date.now() + 2 * 60_000),
            });
            await repo.deleteSession(tx, browserSessionId);
            await auditRepository.append(tx, {
                actorId: userId,
                action: "identity.desktop.browser_session.consume",
                targetId: browserSessionId,
            });
            return code;
        });
    },
    cancel(nonce) {
        return transaction((tx) => repo.deleteVerification(tx, `${REQUEST_PREFIX}${hash(nonce)}`));
    },
    exchange(code, verifier) {
        return transaction(async (tx) => {
            const record = await repo.verification(tx, `${CODE_PREFIX}${hash(code)}`);
            if (!record)
                fail(401, "INVALID_DESKTOP_CODE", "Desktop code unavailable");
            await repo.deleteVerificationById(tx, record.id);
            if (record.expiresAt <= new Date())
                fail(401, "INVALID_DESKTOP_CODE", "Desktop code unavailable");
            const value = JSON.parse(record.value);
            const actual = Buffer.from(hash(verifier), "hex");
            const expected = Buffer.from(value.challenge ?? "", "hex");
            if (actual.length !== expected.length ||
                !timingSafeEqual(actual, expected))
                fail(401, "INVALID_DESKTOP_CODE", "Desktop code unavailable");
            const user = await repo.user(tx, value.userId);
            if (!user || !user.emailVerified)
                fail(401, "UNAUTHENTICATED", "User unavailable");
            const token = `north_session_${randomBytes(32).toString("hex")}`;
            const session = await repo.createSession(tx, user.id, token, new Date(Date.now() + 12 * 60 * 60_000));
            await auditRepository.append(tx, {
                actorId: user.id,
                action: "identity.desktop.session.create",
                targetId: session.id,
            });
            return { token, user };
        });
    },
    revoke(token) {
        return transaction(async (tx) => {
            const session = await repo.session(tx, token);
            if (!session)
                return;
            await repo.deleteSession(tx, session.id);
            await auditRepository.append(tx, {
                actorId: session.userId,
                action: "identity.desktop.session.revoke",
                targetId: session.id,
            });
        });
    },
};
