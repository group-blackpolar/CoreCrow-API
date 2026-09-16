import { publicUser } from "./repository.js";
export const desktopIdentityRepository = {
    deleteVerification(tx, identifier) {
        return tx.verification.deleteMany({ where: { identifier } });
    },
    createVerification(tx, data) {
        return tx.verification.create({ data });
    },
    verification(tx, identifier) {
        return tx.verification.findFirst({ where: { identifier } });
    },
    deleteVerificationById(tx, id) {
        return tx.verification.delete({ where: { id } });
    },
    user(tx, id) {
        return id
            ? tx.user.findUnique({ where: { id }, select: publicUser })
            : null;
    },
    createSession(tx, userId, token, expiresAt) {
        return tx.session.create({ data: { userId, token, expiresAt } });
    },
    session(tx, token) {
        return tx.session.findUnique({ where: { token } });
    },
    deleteSession(tx, id) {
        return tx.session.delete({ where: { id } });
    },
};
