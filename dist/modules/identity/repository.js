import { prisma } from "../../lib/database.js";
import { randomUUID } from "node:crypto";
export const publicUser = {
    id: true,
    email: true,
    name: true,
    role: true,
    emailVerified: true,
    termsAcceptedAt: true,
    termsVersion: true,
    createdAt: true,
};
export const identities = {
    get(id) {
        return prisma.user.findUnique({ where: { id }, select: publicUser });
    },
    getIn(tx, id) {
        return tx.user.findUnique({ where: { id }, select: publicUser });
    },
    list(limit = 50) {
        return prisma.user.findMany({
            select: publicUser,
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    },
    create(tx, data, password) {
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
    async update(tx, id, data) {
        if (data.role)
            await tx.session.deleteMany({ where: { userId: id } });
        return tx.user.update({ where: { id }, data, select: publicUser });
    },
    acceptTerms(tx, id, version, acceptedAt) {
        return tx.user.update({
            where: { id },
            data: { termsVersion: version, termsAcceptedAt: acceptedAt },
            select: publicUser,
        });
    },
    delete(tx, id) {
        return tx.user.delete({ where: { id }, select: publicUser });
    },
};
