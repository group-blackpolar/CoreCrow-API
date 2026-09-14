import { prisma } from "../../lib/database.js";
export const auditRepository = {
    append(tx, event) {
        return tx.auditLog.create({ data: event });
    },
    list(organizationId, limit, before) {
        return prisma.auditLog.findMany({
            where: {
                organizationId,
                ...(before ? { createdAt: { lt: before } } : {}),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit,
        });
    },
    globalList(tx, query) {
        return tx.auditLog.findMany({
            where: {
                ...(query.action ? { action: query.action } : {}),
                ...(query.actorId ? { actorId: query.actorId } : {}),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: query.limit,
            ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
            select: {
                id: true,
                actorId: true,
                organizationId: true,
                action: true,
                targetType: true,
                targetId: true,
                createdAt: true,
            },
        });
    },
};
