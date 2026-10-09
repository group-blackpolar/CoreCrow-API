import { prisma, Prisma, type AIApplication, type AIRunStatus } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";

const conversationView = {
  id: true, organizationId: true, userId: true, application: true, title: true,
  createdAt: true, updatedAt: true,
} as const;

export const aiRepository = {
  createConversation(tx: Transaction, data: {
    organizationId: string; userId: string; application: AIApplication; title?: string;
  }) {
    return tx.aIConversation.create({ data, select: conversationView });
  },
  listConversations(userId: string, organizationId: string) {
    return prisma.aIConversation.findMany({
      where: { userId, organizationId }, select: conversationView,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 50,
    });
  },
  conversation(userId: string, organizationId: string, id: string) {
    return prisma.aIConversation.findFirst({
      where: { id, userId, organizationId },
      select: { ...conversationView, messages: {
        select: { id: true, runId: true, role: true, content: true, toolName: true, toolCallId: true, createdAt: true },
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }], take: 200,
      } },
    });
  },
  conversationIn(tx: Transaction, userId: string, organizationId: string, id: string) {
    return tx.aIConversation.findFirst({ where: { id, userId, organizationId } });
  },
  recentCounts(tx: Transaction, userId: string, organizationId: string, since: Date) {
    return Promise.all([
      tx.aIRun.count({ where: { userId, createdAt: { gte: since } } }),
      tx.aIRun.count({ where: { organizationId, createdAt: { gte: since } } }),
      tx.aIRun.count({ where: { userId, status: { in: ["QUEUED", "RUNNING", "WAITING_CONFIRMATION"] } } }),
      tx.aIRun.count({ where: { organizationId, status: { in: ["QUEUED", "RUNNING", "WAITING_CONFIRMATION"] } } }),
    ]);
  },
  async createRun(tx: Transaction, data: {
    conversationId: string; organizationId: string; userId: string; application: AIApplication;
    provider: string; model: string; prompt: string;
  }) {
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
  run(userId: string, organizationId: string, id: string) {
    return prisma.aIRun.findFirst({
      where: { id, userId, organizationId },
      include: { usage: true, actions: true, toolCalls: true },
    });
  },
  runById(id: string) {
    return prisma.aIRun.findUnique({ where: { id }, include: { conversation: true } });
  },
  async claim(id: string) {
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
  async history(conversationId: string, take: number) {
    const messages = await prisma.aIMessage.findMany({
      where: { conversationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
      select: { role: true, content: true, toolName: true, toolCallId: true },
    });
    return messages.reverse();
  },
  addMessage(data: { conversationId: string; runId: string; role: "ASSISTANT" | "TOOL"; content: string; toolName?: string; toolCallId?: string }) {
    return prisma.aIMessage.create({ data });
  },
  async addEvent(runId: string, type: string, data: Prisma.InputJsonValue) {
    return prisma.$transaction(async (tx) => {
      const latest = await tx.aIEvent.aggregate({ where: { runId }, _max: { sequence: true } });
      return tx.aIEvent.create({ data: { runId, type, data, sequence: (latest._max.sequence ?? 0) + 1 } });
    }, { isolationLevel: "Serializable" });
  },
  events(runId: string, after: number) {
    return prisma.aIEvent.findMany({ where: { runId, sequence: { gt: after } }, orderBy: { sequence: "asc" }, take: 100 });
  },
  cancellationRequested(id: string) {
    return prisma.aIRun.findUnique({ where: { id }, select: { cancellationRequestedAt: true, status: true } });
  },
  requestCancellation(id: string) {
    return prisma.aIRun.update({ where: { id }, data: { cancellationRequestedAt: new Date() } });
  },
  terminal(id: string, status: Extract<AIRunStatus, "COMPLETED" | "FAILED" | "CANCELLED">, error?: { code: string; message: string }) {
    return prisma.aIRun.update({ where: { id }, data: {
      status, completedAt: new Date(), failureCode: error?.code, failureMessage: error?.message,
    } });
  },
  createToolCall(runId: string, providerId: string, name: string, risk: string, args: Prisma.InputJsonValue) {
    return prisma.aIToolCall.create({ data: { runId, providerId, name, risk, arguments: args } });
  },
  startToolCall(id: string) {
    return prisma.aIToolCall.update({ where: { id }, data: { status: "RUNNING" } });
  },
  completeToolCall(id: string, result: Prisma.InputJsonValue) {
    return prisma.aIToolCall.update({ where: { id }, data: { status: "COMPLETED", result, completedAt: new Date() } });
  },
  failToolCall(id: string, errorCode: string) {
    return prisma.aIToolCall.update({ where: { id }, data: { status: "FAILED", errorCode, completedAt: new Date() } });
  },
  addUsage(data: {
    runId: string; conversationId: string; organizationId: string; userId: string;
    application: AIApplication; provider: string; model: string; inputTokens: number;
    outputTokens: number; totalTokens: number; latencyMs: number; estimatedCostMicrousd: bigint; pricingVersion: string;
  }) { return prisma.aIUsage.create({ data }); },
  action(userId: string, id: string) {
    return prisma.aIAction.findFirst({ where: { id, userId } });
  },
  updateAction(id: string, status: "CONFIRMED" | "CANCELLED" | "EXPIRED" | "FAILED") {
    return prisma.aIAction.update({ where: { id }, data: {
      status, ...(status === "CONFIRMED" ? { confirmedAt: new Date() } : {}),
      ...(status === "CANCELLED" ? { cancelledAt: new Date() } : {}),
    } });
  },
};
