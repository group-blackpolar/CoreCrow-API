import { prisma } from "../../lib/database.js";
export const legacyIdentity = {
    user(tx, email) { return tx.user.findUnique({ where: { email } }); },
    credential(tx, userId) { return tx.account.findFirst({ where: { userId, providerId: "credential" }, select: { id: true } }); },
    session(token) { return prisma.session.findUnique({ where: { token }, include: { user: true } }); },
    createSession(tx, userId, token, ipAddress) { return tx.session.create({ data: { userId, token, ipAddress, expiresAt: new Date(Date.now() + 3600000) } }); },
    async migrate(tx, userId, password) {
        await tx.account.create({ data: { userId, accountId: userId, providerId: "credential", password } });
        await tx.user.update({ where: { id: userId }, data: { adminUniqueId: null } });
        await tx.session.deleteMany({ where: { userId } });
    },
};
