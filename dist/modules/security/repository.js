import { prisma } from "../../lib/database.js";
const projection = {
    id: true,
    name: true,
    prefix: true,
    scopes: true,
    lastUsed: true,
    expiresAt: true,
    revokedAt: true,
    createdAt: true,
};
export const keys = {
    find(keyHash) {
        return prisma.apiKey.findUnique({ where: { keyHash } });
    },
    create(tx, data) {
        return tx.apiKey.create({ data, select: projection });
    },
    list(userId) {
        return prisma.apiKey.findMany({
            where: { userId },
            select: projection,
            take: 100,
            orderBy: { createdAt: "desc" },
        });
    },
    findOwned(tx, id, userId) {
        return tx.apiKey.findFirst({ where: { id, userId }, select: projection });
    },
    revoke(tx, id) {
        return tx.apiKey.update({
            where: { id },
            data: { revokedAt: new Date() },
            select: projection,
        });
    },
    used(id) {
        return prisma.apiKey.update({
            where: { id },
            data: { lastUsed: new Date() },
        });
    },
};
