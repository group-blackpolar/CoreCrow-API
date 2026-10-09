import { prisma } from "../../lib/database.js";
const conversationView = {
    id: true, organizationId: true, userId: true, application: true, title: true,
    createdAt: true, updatedAt: true,
};
export const aiRepository = {
    createConversation(tx, data) {
        return tx.aIConversation.create({ data, select: conversationView });
    },
    listConversations(userId, organizationId) {
        return prisma.aIConversation.findMany({
            where: { userId, organizationId }, select: conversationView,
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 50,
        });
    },
    conversation(userId, organizationId, id) {
        return prisma.aIConversation.findFirst({
            where: { id, userId, organizationId },
            select: { ...conversationView, messages: {
                    select: { id: true, runId: true, role: true, content: true, toolName: true, toolCallId: true, createdAt: true },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200,
                } },
        });
    },
    conversationIn(tx, userId, organizationId, id) {
        return tx.aIConversation.findFirst({ where: { id, userId, organizationId } });
    },
    recentCounts(tx, userId, organizationId, since) {
        return Promise.all([
            tx.aIRun.count({ where: { userId, createdAt: { gte: since } } }),
            tx.aIRun.count({ where: { organizationId, createdAt: { gte: since } } }),
            tx.aIRun.count({ where: { userId, status: { in: ["QUEUED", "RUNNING", "WAITING_CONFIRMATION"] } } }),
            tx.aIRun.count({ where: { organizationId, status: { in: ["QUEUED", "RUNNING", "WAITING_CONFIRMATION"] } } }),
        ]);
    },
    async createRun(tx, data) {
        const run = await tx.aIRun.create({ data: {
                conversationId: data.conversationId, organizationId: data.organizationId,
                userId: data.userId, application: data.application, provider: data.provider, model: data.model,
            } });
        await tx.aIMessage.create({ data: {
                conversationId: data.conversationId, runId: run.id, role: "USER", content: data.prompt,
            } });
        await tx.aIConversation.update({ where: { id: data.conversationId }, data: { updatedAt: new Date() } });
        return run;
    },
    run(userId, organizationId, id) {
        return prisma.aIRun.findFirst({
            where: { id, userId, organizationId },
            include: { usage: true, actions: true, toolCalls: true },
        });
    },
    runById(id) {
        return prisma.aIRun.findUnique({ where: { id }, include: { conversation: true } });
    },
    async claim(id) {
        const claimed = await prisma.aIRun.updateMany({
            where: { id, status: "QUEUED", cancellationRequestedAt: null },
            data: { status: "RUNNING", startedAt: new Date() },
        });
        return claimed.count === 1;
    },
    async recoverInterrupted() {
        await prisma.aIRun.updateMany({
            where: { status: "RUNNING" },
            data: { status: "QUEUED", startedAt: null },
        });
        return prisma.aIRun.findMany({
            where: { status: "QUEUED", cancellationRequestedAt: null },
            select: { id: true }, orderBy: { createdAt: "asc" }, take: 100,
        });
    },
    async history(conversationId, take) {
        const messages = await prisma.aIMessage.findMany({
            where: { conversationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
            select: { role: true, content: true, toolName: true, toolCallId: true },
        });
        return messages.reverse();
    },
    addMessage(data) {
        return prisma.aIMessage.create({ data });
    },
    async addEvent(runId, type, data) {
        return prisma.$transaction(async (tx) => {
            const latest = await tx.aIEvent.aggregate({ where: { runId }, _max: { sequence: true } });
            return tx.aIEvent.create({ data: { runId, type, data, sequence: (latest._max.sequence ?? 0) + 1 } });
        }, { isolationLevel: "Serializable" });
    },
    events(runId, after) {
        return prisma.aIEvent.findMany({ where: { runId, sequence: { gt: after } }, orderBy: { sequence: "asc" }, take: 100 });
    },
    cancellationRequested(id) {
        return prisma.aIRun.findUnique({ where: { id }, select: { cancellationRequestedAt: true, status: true } });
    },
    requestCancellation(id) {
        return prisma.aIRun.update({ where: { id }, data: { cancellationRequestedAt: new Date() } });
    },
    terminal(id, status, error) {
        return prisma.aIRun.update({ where: { id }, data: {
                status, completedAt: new Date(), failureCode: error?.code, failureMessage: error?.message,
            } });
    },
    createToolCall(runId, providerId, name, risk, args) {
        return prisma.aIToolCall.create({ data: { runId, providerId, name, risk, arguments: args } });
    },
    startToolCall(id) {
        return prisma.aIToolCall.update({ where: { id }, data: { status: "RUNNING" } });
    },
    completeToolCall(id, result) {
        return prisma.aIToolCall.update({ where: { id }, data: { status: "COMPLETED", result, completedAt: new Date() } });
    },
    failToolCall(id, errorCode) {
        return prisma.aIToolCall.update({ where: { id }, data: { status: "FAILED", errorCode, completedAt: new Date() } });
    },
    addUsage(data) { return prisma.aIUsage.create({ data }); },
    action(userId, id) {
        return prisma.aIAction.findFirst({ where: { id, userId } });
    },
    updateAction(id, status) {
        return prisma.aIAction.update({ where: { id }, data: {
                status, ...(status === "CONFIRMED" ? { confirmedAt: new Date() } : {}),
                ...(status === "CANCELLED" ? { cancelledAt: new Date() } : {}),
            } });
    },
};
