import { prisma } from "../../lib/database.js";
import { publicUser } from "./repository.js";
const credentialWhere = (userId) => ({
    userId,
    providerId: "credential",
});
export const credentials = {
    bootstrapIdentity(tx, email) {
        return tx.user.findUnique({ where: { email } });
    },
    otherSuperadmin(tx, userId) {
        return tx.user.findFirst({
            where: { role: "SUPERADMIN", id: { not: userId } },
            select: { id: true },
        });
    },
    credentialAccounts(tx, userId) {
        return tx.account.findMany({
            where: credentialWhere(userId),
            select: { id: true, password: true },
            take: 2,
        });
    },
    createCredential(tx, userId, password) {
        return tx.account.create({
            data: {
                userId,
                accountId: userId,
                providerId: "credential",
                password,
            },
            select: { id: true },
        });
    },
    updateCredential(tx, accountId, password) {
        return tx.account.update({
            where: { id: accountId },
            data: { password },
            select: { id: true },
        });
    },
    configureOperator(tx, userId, adminSecretHash) {
        return tx.user.update({
            where: { id: userId },
            data: {
                role: "SUPERADMIN",
                adminSecretHash,
                passwordChangeRequired: true,
            },
            select: publicUser,
        });
    },
    revokeAllSessions(tx, userId) {
        return tx.session.deleteMany({ where: { userId } });
    },
    passwordState(userId) {
        return prisma.user.findUnique({
            where: { id: userId },
            select: {
                passwordChangeRequired: true,
                accounts: {
                    where: { providerId: "credential" },
                    select: { id: true, password: true },
                    take: 2,
                },
            },
        });
    },
    passwordStateIn(tx, userId) {
        return tx.user.findUnique({
            where: { id: userId },
            select: {
                passwordChangeRequired: true,
                accounts: {
                    where: { providerId: "credential" },
                    select: { id: true, password: true },
                    take: 2,
                },
            },
        });
    },
    session(tx, sessionId, userId) {
        return tx.session.findFirst({
            where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
            select: { id: true },
        });
    },
    clearPasswordChangeRequired(tx, userId) {
        return tx.user.update({
            where: { id: userId },
            data: { passwordChangeRequired: false },
            select: publicUser,
        });
    },
    revokeOtherSessions(tx, userId, currentSessionId) {
        return tx.session.deleteMany({
            where: { userId, id: { not: currentSessionId } },
        });
    },
};
