import type { Transaction } from "../../shared/transaction.js";
import { publicUser } from "./repository.js";

export const desktopIdentityRepository = {
  deleteVerification(tx: Transaction, identifier: string) {
    return tx.verification.deleteMany({ where: { identifier } });
  },
  createVerification(
    tx: Transaction,
    data: { identifier: string; value: string; expiresAt: Date },
  ) {
    return tx.verification.create({ data });
  },
  verification(tx: Transaction, identifier: string) {
    return tx.verification.findFirst({ where: { identifier } });
  },
  deleteVerificationById(tx: Transaction, id: string) {
    return tx.verification.delete({ where: { id } });
  },
  user(tx: Transaction, id?: string) {
    return id
      ? tx.user.findUnique({ where: { id }, select: publicUser })
      : null;
  },
  createSession(tx: Transaction, userId: string, token: string, expiresAt: Date) {
    return tx.session.create({ data: { userId, token, expiresAt } });
  },
  session(tx: Transaction, token: string) {
    return tx.session.findUnique({ where: { token } });
  },
  deleteSession(tx: Transaction, id: string) {
    return tx.session.delete({ where: { id } });
  },
};
