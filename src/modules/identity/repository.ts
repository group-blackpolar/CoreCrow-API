import { prisma, type Role } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import { randomUUID } from "node:crypto";
export const publicUser = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
  createdAt: true,
} as const;
export const identities = {
  get(id: string) {
    return prisma.user.findUnique({ where: { id }, select: publicUser });
  },
  getIn(tx: Transaction, id: string) {
    return tx.user.findUnique({ where: { id }, select: publicUser });
  },
  list(limit = 50) {
    return prisma.user.findMany({
      select: publicUser,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
  create(
    tx: Transaction,
    data: { email: string; name: string; role: Role },
    password: string,
  ) {
    const id = randomUUID();
    return tx.user.create({
      data: {
        id,
        ...data,
        accounts: {
          create: { accountId: id, providerId: "credential", password },
        },
      },
      select: publicUser,
    });
  },
  async update(
    tx: Transaction,
    id: string,
    data: { name?: string; role?: Role },
  ) {
    if (data.role) await tx.session.deleteMany({ where: { userId: id } });
    return tx.user.update({ where: { id }, data, select: publicUser });
  },
  delete(tx: Transaction, id: string) {
    return tx.user.delete({ where: { id }, select: publicUser });
  },
};
