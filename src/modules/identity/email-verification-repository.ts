import type { Transaction } from "../../shared/transaction.js";

export const emailVerificationRepository = {
  userByEmail(tx: Transaction, email: string) {
    return tx.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, emailVerified: true },
    });
  },
  challengeByUser(tx: Transaction, userId: string) {
    return tx.emailVerificationChallenge.findUnique({ where: { userId } });
  },
  replaceChallenge(
    tx: Transaction,
    input: { userId: string; codeHash: string; expiresAt: Date },
  ) {
    return tx.emailVerificationChallenge.upsert({
      where: { userId: input.userId },
      create: input,
      update: {
        codeHash: input.codeHash,
        attempts: 0,
        expiresAt: input.expiresAt,
        createdAt: new Date(),
      },
    });
  },
  incrementAttempts(tx: Transaction, id: string) {
    return tx.emailVerificationChallenge.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  },
  deleteChallenge(tx: Transaction, id: string) {
    return tx.emailVerificationChallenge.delete({ where: { id } });
  },
  verifyUser(tx: Transaction, userId: string) {
    return tx.user.update({
      where: { id: userId },
      data: { emailVerified: true },
      select: { id: true },
    });
  },
};
