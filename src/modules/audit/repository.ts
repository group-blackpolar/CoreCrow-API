import { prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import type { Prisma } from "../../lib/database.js";
import { currentRequestId } from "../../shared/request-context.js";
export const auditRepository = {
  append(
    tx: Transaction,
    event: {
      actorId?: string;
      organizationId?: string;
      action: string;
      targetType?: string;
      targetId?: string;
      requestId?: string;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    return tx.auditLog.create({ data: { ...event, requestId: event.requestId ?? currentRequestId() } });
  },
  list(organizationId: string, limit: number, before?: Date) {
    return prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
  },
  globalList(
    tx: Transaction,
    query: {
      limit: number;
      cursor?: string;
      action?: string;
      actorId?: string;
      targetType?: string;
      targetId?: string;
      from?: Date;
      to?: Date;
    },
  ) {
    const createdAt =
      query.from || query.to
        ? {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          }
        : undefined;
    // One extra row is fetched so the caller can compute a real nextCursor.
    return tx.auditLog.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.targetType ? { targetType: query.targetType } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      select: {
        id: true,
        actorId: true,
        organizationId: true,
        action: true,
        targetType: true,
        targetId: true,
        requestId: true,
        metadata: true,
        createdAt: true,
      },
    });
  },
};
