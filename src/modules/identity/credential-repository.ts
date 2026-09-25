import { prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import { publicUser } from "./repository.js";

const credentialWhere = (userId: string) => ({
  userId,
  providerId: "credential",
});

export const credentials = {
  bootstrapIdentity(tx: Transaction, email: string) {
    return tx.user.findUnique({ where: { email } });
  },
  otherSuperadmin(tx: Transaction, userId: string) {
    return tx.user.findFirst({
      where: { role: "SUPERADMIN", id: { not: userId } },
      select: { id: true },
    });
  },
  credentialAccounts(tx: Transaction, userId: string) {
    return tx.account.findMany({
      where: credentialWhere(userId),
      select: { id: true, password: true },
      take: 2,
    });
  },
  createCredential(tx: Transaction, userId: string, password: string) {
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
  updateCredential(
    tx: Transaction,
    accountId: string,
    password: string,
  ) {
    return tx.account.update({
      where: { id: accountId },
      data: { password },
      select: { id: true },
    });
  },
  configureOperator(
    tx: Transaction,
    userId: string,
    adminSecretHash: string,
  ) {
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
  revokeAllSessions(tx: Transaction, userId: string) {
    return tx.session.deleteMany({ where: { userId } });
  },
  passwordState(userId: string) {
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
  passwordStateIn(tx: Transaction, userId: string) {
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
  session(tx: Transaction, sessionId: string, userId: string) {
    return tx.session.findFirst({
      where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
  },
  clearPasswordChangeRequired(tx: Transaction, userId: string) {
    return tx.user.update({
      where: { id: userId },
      data: { passwordChangeRequired: false },
      select: publicUser,
    });
  },
  revokeOtherSessions(
    tx: Transaction,
    userId: string,
    currentSessionId: string,
  ) {
    return tx.session.deleteMany({
      where: { userId, id: { not: currentSessionId } },
    });
  },
};
