import { prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
export const legacyIdentity = {
  user(tx: Transaction, email: string) { return tx.user.findUnique({ where: { email } }); },
  credential(tx: Transaction, userId: string) { return tx.account.findFirst({ where: { userId, providerId: "credential" }, select: { id: true } }); },
  session(token: string) { return prisma.session.findUnique({ where: { token }, include: { user: true } }); },
  createSession(tx: Transaction, userId: string, token: string, ipAddress: string) { return tx.session.create({ data: { userId, token, ipAddress, expiresAt: new Date(Date.now() + 3600000) } }); },
  async migrate(tx: Transaction, userId: string, password: string) {
    await tx.account.create({ data: { userId, accountId: userId, providerId: "credential", password } });
    await tx.user.update({ where: { id: userId }, data: { adminUniqueId: null } });
    await tx.session.deleteMany({ where: { userId } });
  },
};
