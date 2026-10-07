import { prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";

export const adminSecrets = {
  findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        emailVerified: true,
        passwordChangeRequired: true,
        termsAcceptedAt: true,
        termsVersion: true,
        createdAt: true,
        adminSecretHash: true,
      },
    });
  },
  authenticationState(tx: Transaction, userId: string) {
    return tx.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        status: true,
        emailVerified: true,
        adminSecretHash: true,
      },
    });
  },
  stateFor(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { role: true, adminSecretHash: true, adminSecretCiphertext: true, adminSecretEncryptionVersion: true } });
  },
  stateIn(tx: Transaction, userId: string) {
    return tx.user.findUnique({ where: { id: userId }, select: { role: true, adminSecretHash: true, adminSecretCiphertext: true, adminSecretEncryptionVersion: true } });
  },
  /** Hash and ciphertext are always written together; a null ciphertext clears any stale one. */
  setCredential(
    tx: Transaction,
    userId: string,
    adminSecretHash: string,
    sealed: { ciphertext: string; version: number } | null,
  ) {
    return tx.user.update({
      where: { id: userId },
      data: {
        adminSecretHash,
        adminSecretCiphertext: sealed?.ciphertext ?? null,
        adminSecretEncryptionVersion: sealed?.version ?? null,
      },
      select: { id: true },
    });
  },
  createSession(
    tx: Transaction,
    userId: string,
    token: string,
    ipAddress: string,
    expiresAt: Date,
  ) {
    return tx.session.create({
      data: { userId, token, ipAddress, userAgent: "", expiresAt },
    });
  },
};
