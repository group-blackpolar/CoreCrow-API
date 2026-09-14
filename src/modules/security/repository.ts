import { prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
const projection = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  lastUsed: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;
export const keys = {
  find(keyHash: string) {
    return prisma.apiKey.findUnique({ where: { keyHash } });
  },
  create(
    tx: Transaction,
    data: {
      userId: string;
      name: string;
      keyHash: string;
      prefix: string;
      scopes: string[];
      expiresAt: Date;
    },
  ) {
    return tx.apiKey.create({ data, select: projection });
  },
  list(userId: string) {
    return prisma.apiKey.findMany({
      where: { userId },
      select: projection,
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  },
  findOwned(tx: Transaction, id: string, userId: string) {
    return tx.apiKey.findFirst({ where: { id, userId }, select: projection });
  },
  revoke(tx: Transaction, id: string) {
    return tx.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
      select: projection,
    });
  },
  used(id: string) {
    return prisma.apiKey.update({
      where: { id },
      data: { lastUsed: new Date() },
    });
  },
};
