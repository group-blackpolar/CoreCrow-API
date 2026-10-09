import { transaction } from "../../shared/transaction.js";
import { DomainError, fail } from "../../shared/errors.js";
import { auditRepository as audit } from "../audit/repository.js";
import { aiConfiguration, requireAIEnabled } from "./config.js";
import { authorizeAI } from "./authorization.js";
import { aiRepository as repo } from "./repository.js";
import { GeminiProvider } from "./gemini.provider.js";
import { aiTools } from "./tool-registry.js";
import { systemInstructions } from "./system-instructions.js";
const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const silentLogger = { info() { }, error() { } };
function application(value) {
    return value.toUpperCase();
}
function publicApplication(value) {
    return value.toLowerCase();
}
export function publicAIRun(run) {
    return {
        id: run.id,
        conversationId: run.conversationId,
        organizationId: run.organizationId,
        userId: run.userId,
        application: publicApplication(run.application),
        status: run.status,
        provider: run.provider,
        model: run.model,
        failureCode: run.failureCode,
        failureMessage: run.failureMessage,
        cancellationRequestedAt: run.cancellationRequestedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        usage: run.usage.map((entry) => ({
            id: entry.id,
            provider: entry.provider,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            latencyMs: entry.latencyMs,
            estimatedCostMicrousd: entry.estimatedCostMicrousd.toString(),
            pricingVersion: entry.pricingVersion,
            createdAt: entry.createdAt,
        })),
        actions: run.actions.map(publicAIAction),
        toolCalls: run.toolCalls.map((entry) => ({
            id: entry.id,
            name: entry.name,
            risk: entry.risk,
            status: entry.status,
            errorCode: entry.errorCode,
        })),
    };
}
function publicAIAction(action) {
    return { id: action.id, status: action.status, toolName: action.toolName, expiresAt: action.expiresAt };
}
export function boundedAIHistory(messages, maxCharacters) {
    const selected = [];
    let remaining = maxCharacters;
    for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
        const message = messages[index];
        const content = message.content.slice(0, remaining);
        selected.push({ ...message, content });
        remaining -= content.length;
    }
    return selected.reverse();
}
export function assertPendingAIAction(action, now = new Date()) {
    if (action.status !== "PENDING_CONFIRMATION")
        fail(409, "AI_ACTION_NOT_PENDING", "AI action is not pending confirmation");
    if (action.expiresAt <= now)
        fail(409, "AI_ACTION_EXPIRED", "AI action has expired");
}
export async function reauthorizeAIAction(authorizer, actorId, action, permissions) {
    if (actorId !== action.userId)
        fail(404, "NOT_FOUND", "AI action not found");
    return authorizer(action.userId, action.organizationId, permissions);
}
function safeJson(value) {
    return JSON.parse(JSON.stringify(value));
}
async function auditEvent(event) {
    await transaction((tx) => audit.append(tx, event));
}
export class AIService {
    configuration;
    registry;
    controllers = new Map();
    providerInstance;
    logger = silentLogger;
    constructor(configuration = aiConfiguration(), provider, registry = aiTools) {
        this.configuration = configuration;
        this.registry = registry;
        this.providerInstance = provider;
    }
    configureLogger(logger) { this.logger = logger; }
    enabled() { return requireAIEnabled(this.configuration); }
    provider() {
        return this.providerInstance ??= new GeminiProvider(this.configuration.geminiApiKey, this.configuration.providerTimeoutMs, this.configuration.geminiBaseUrl);
    }
    async resumePendingRuns() {
        if (!this.configuration.enabled || !this.configuration.geminiApiKey)
            return;
        const recovered = await repo.recoverInterrupted();
        setImmediate(() => { void this.drainRecoveredRuns(recovered.map((run) => run.id)); });
    }
    async drainRecoveredRuns(runIds) {
        for (const runId of runIds)
            await this.execute(runId);
    }
    async createConversation(userId, input) {
        this.enabled();
        await authorizeAI(userId, input.organizationId, ["organization.read"]);
        return transaction(async (tx) => {
            const conversation = await repo.createConversation(tx, {
                organizationId: input.organizationId, userId,
                application: application(input.application), title: input.title,
            });
            await audit.append(tx, {
                actorId: userId, organizationId: input.organizationId,
                action: "ai.conversation.created", targetType: "AIConversation", targetId: conversation.id,
                metadata: { application: input.application },
            });
            return { ...conversation, application: publicApplication(conversation.application) };
        });
    }
    async listConversations(userId, organizationId) {
        this.enabled();
        await authorizeAI(userId, organizationId, ["organization.read"]);
        const items = await repo.listConversations(userId, organizationId);
        return items.map((item) => ({ ...item, application: publicApplication(item.application) }));
    }
    async conversation(userId, organizationId, id) {
        this.enabled();
        await authorizeAI(userId, organizationId, ["organization.read"]);
        const value = await repo.conversation(userId, organizationId, id);
        if (!value)
            fail(404, "NOT_FOUND", "Conversation not found");
        return { ...value, application: publicApplication(value.application) };
    }
    async createRun(userId, input) {
        const configuration = this.enabled();
        if (input.message.length > configuration.messageMaxCharacters)
            fail(400, "AI_MESSAGE_TOO_LONG", "AI message exceeds the configured limit");
        await authorizeAI(userId, input.organizationId, ["organization.read"]);
        const run = await transaction(async (tx) => {
            const conversation = await repo.conversationIn(tx, userId, input.organizationId, input.conversationId);
            if (!conversation || conversation.application !== application(input.application))
                fail(404, "NOT_FOUND", "Conversation not found");
            const [userRecent, organizationRecent, userActive, organizationActive] = await repo.recentCounts(tx, userId, input.organizationId, new Date(Date.now() - 60_000));
            if (userRecent >= configuration.userRunsPerMinute || organizationRecent >= configuration.organizationRunsPerMinute)
                fail(429, "AI_RATE_LIMITED", "AI run rate limit exceeded");
            if (userActive >= configuration.userConcurrentRuns || organizationActive >= configuration.organizationConcurrentRuns)
                fail(429, "AI_CONCURRENCY_LIMITED", "AI concurrent run limit exceeded");
            const created = await repo.createRun(tx, {
                conversationId: input.conversationId, organizationId: input.organizationId,
                userId, application: application(input.application), provider: this.provider().name,
                model: configuration.model, prompt: input.message,
            });
            await audit.append(tx, {
                actorId: userId, organizationId: input.organizationId, action: "ai.run.created",
                targetType: "AIRun", targetId: created.id,
                metadata: { application: input.application, provider: this.provider().name, model: configuration.model },
            });
            return created;
        });
        setImmediate(() => { void this.execute(run.id); });
        return { runId: run.id };
    }
    async run(userId, organizationId, id) {
        this.enabled();
        await authorizeAI(userId, organizationId, ["organization.read"]);
        const run = await repo.run(userId, organizationId, id);
        if (!run)
            fail(404, "NOT_FOUND", "Run not found");
        return publicAIRun(run);
    }
    async events(userId, organizationId, id, after) {
        const run = await this.run(userId, organizationId, id);
        return { run, events: await repo.events(id, after), terminal: terminal.has(run.status) };
    }
    async cancelRun(userId, organizationId, id) {
        const run = await this.run(userId, organizationId, id);
        if (terminal.has(run.status))
            return run;
        await repo.requestCancellation(id);
        this.controllers.get(id)?.abort();
        if (run.status === "QUEUED") {
            await repo.terminal(id, "CANCELLED");
            await repo.addEvent(id, "run.cancelled", { runId: id });
            await auditEvent({ actorId: userId, organizationId, action: "ai.run.cancelled", targetType: "AIRun", targetId: id });
        }
        else {
            await auditEvent({ actorId: userId, organizationId, action: "ai.run.cancellation_requested", targetType: "AIRun", targetId: id });
        }
        return this.run(userId, organizationId, id);
    }
    async confirmAction(userId, id) {
        this.enabled();
        const action = await repo.action(userId, id);
        if (!action)
            fail(404, "NOT_FOUND", "AI action not found");
        await reauthorizeAIAction(authorizeAI, userId, action, []);
        try {
            assertPendingAIAction(action);
        }
        catch (error) {
            if (error instanceof DomainError && error.code === "AI_ACTION_EXPIRED")
                await repo.updateAction(id, "EXPIRED");
            throw error;
        }
        const tool = this.registry.find(action.toolName);
        if (!tool || tool.risk !== "mutation") {
            await repo.updateAction(id, "FAILED");
            await auditEvent({ actorId: userId, organizationId: action.organizationId, action: "ai.action.failed", targetType: "AIAction", targetId: id, metadata: { code: "AI_ACTION_UNAVAILABLE" } });
            fail(422, "AI_ACTION_UNAVAILABLE", "AI action is not enabled");
        }
        await reauthorizeAIAction(authorizeAI, userId, action, tool.requiredPermissions);
        fail(422, "AI_ACTION_UNAVAILABLE", "Mutation tools are not enabled in this MVP");
    }
    async cancelAction(userId, id) {
        this.enabled();
        const action = await repo.action(userId, id);
        if (!action)
            fail(404, "NOT_FOUND", "AI action not found");
        await reauthorizeAIAction(authorizeAI, userId, action, []);
        assertPendingAIAction(action);
        const result = await repo.updateAction(id, "CANCELLED");
        await auditEvent({ actorId: userId, organizationId: action.organizationId, action: "ai.action.cancelled", targetType: "AIAction", targetId: id });
        return publicAIAction(result);
    }
    async execute(runId) {
        if (!(await repo.claim(runId)))
            return;
        const run = await repo.runById(runId);
        if (!run)
            return;
        const context = {
            userId: run.userId, organizationId: run.organizationId,
            application: publicApplication(run.application),
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.configuration.runTimeoutMs);
        this.controllers.set(runId, controller);
        let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const started = Date.now();
        try {
            this.logger.info({ runId, organizationId: run.organizationId, userId: run.userId, provider: run.provider, model: run.model }, "AI run started");
            await authorizeAI(run.userId, run.organizationId, ["organization.read"]);
            await repo.addEvent(runId, "run.started", { runId });
            await auditEvent({ actorId: run.userId, organizationId: run.organizationId, action: "ai.run.started", targetType: "AIRun", targetId: runId, metadata: { provider: run.provider, model: run.model } });
            const available = await this.registry.available(context);
            const history = (await repo.history(run.conversationId, this.configuration.contextMaxMessages)).map((message) => ({
                role: message.role.toLowerCase(),
                content: message.content, toolName: message.toolName ?? undefined, toolCallId: message.toolCallId ?? undefined,
            }));
            const messages = boundedAIHistory(history, this.configuration.contextMaxCharacters);
            for (let round = 0; round <= this.configuration.maxToolRounds; round++) {
                let response;
                const streamedCalls = new Map();
                for await (const event of this.provider().stream({
                    model: run.model, maxOutputTokens: this.configuration.maxOutputTokens,
                    messages, tools: this.registry.providerTools(available),
                    systemInstruction: systemInstructions(context.application, available.map((tool) => tool.name)),
                }, controller.signal)) {
                    if (event.type === "text.delta")
                        await repo.addEvent(runId, "message.delta", { text: event.text });
                    if (event.type === "tool.call")
                        streamedCalls.set(event.call.id, event.call);
                    if (event.type === "completed")
                        response = event.response;
                }
                if (!response)
                    fail(503, "AI_PROVIDER_UNAVAILABLE", "AI provider returned no completion");
                if (streamedCalls.size)
                    response.toolCalls = [...streamedCalls.values()];
                usage = {
                    inputTokens: usage.inputTokens + response.usage.inputTokens,
                    outputTokens: usage.outputTokens + response.usage.outputTokens,
                    totalTokens: usage.totalTokens + response.usage.totalTokens,
                };
                if (response.toolCalls.length === 0) {
                    if (response.text) {
                        await repo.addMessage({ conversationId: run.conversationId, runId, role: "ASSISTANT", content: response.text });
                        await repo.addEvent(runId, "message.completed", { text: response.text });
                    }
                    await this.finish(run, usage, started);
                    return;
                }
                if (round === this.configuration.maxToolRounds)
                    fail(422, "AI_TOOL_ROUND_LIMIT", "AI tool round limit exceeded");
                messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
                for (const call of response.toolCalls) {
                    const definition = this.registry.find(call.name);
                    const stored = await repo.createToolCall(runId, call.id, call.name, definition?.risk ?? "unknown", safeJson(call.arguments));
                    this.logger.info({ runId, toolCallId: stored.id, toolName: call.name, risk: definition?.risk ?? "unknown" }, "AI tool proposed");
                    await repo.addEvent(runId, "tool.proposed", { toolCallId: stored.id, name: call.name });
                    await auditEvent({ actorId: run.userId, organizationId: run.organizationId, action: "ai.tool.proposed", targetType: "AIToolCall", targetId: stored.id, metadata: { name: call.name } });
                    try {
                        await repo.startToolCall(stored.id);
                        await repo.addEvent(runId, "tool.started", { toolCallId: stored.id, name: call.name });
                        const executed = await this.registry.execute(context, call.name, call.arguments);
                        const value = safeJson(executed.result);
                        await repo.completeToolCall(stored.id, value);
                        await repo.addMessage({ conversationId: run.conversationId, runId, role: "TOOL", content: JSON.stringify(value), toolName: call.name, toolCallId: call.id });
                        messages.push({ role: "tool", content: JSON.stringify(value), toolName: call.name, toolCallId: call.id });
                        await repo.addEvent(runId, "tool.completed", { toolCallId: stored.id, name: call.name });
                        await auditEvent({ actorId: run.userId, organizationId: run.organizationId, action: "ai.tool.executed", targetType: "AIToolCall", targetId: stored.id, metadata: { name: call.name, risk: executed.tool.risk } });
                    }
                    catch (error) {
                        const code = error instanceof DomainError ? error.code : "AI_TOOL_FAILED";
                        await repo.failToolCall(stored.id, code);
                        await repo.addEvent(runId, "tool.failed", { toolCallId: stored.id, name: call.name, code });
                        await auditEvent({ actorId: run.userId, organizationId: run.organizationId, action: "ai.tool.failed", targetType: "AIToolCall", targetId: stored.id, metadata: { name: call.name, code } });
                        throw error;
                    }
                }
            }
        }
        catch (error) {
            const cancelled = controller.signal.aborted && (await repo.cancellationRequested(runId))?.cancellationRequestedAt;
            const mapped = cancelled
                ? new DomainError(409, "AI_RUN_CANCELLED", "AI run was cancelled")
                : error instanceof DomainError ? error : new DomainError(500, "AI_RUN_FAILED", "AI run failed");
            const status = cancelled ? "CANCELLED" : "FAILED";
            await repo.terminal(runId, status, { code: mapped.code, message: mapped.message });
            this.logger.error({ runId, organizationId: run.organizationId, userId: run.userId, code: mapped.code, status }, "AI run terminated");
            await repo.addEvent(runId, status === "CANCELLED" ? "run.cancelled" : "run.failed", { code: mapped.code });
            await auditEvent({ actorId: run.userId, organizationId: run.organizationId, action: status === "CANCELLED" ? "ai.run.cancelled" : "ai.run.failed", targetType: "AIRun", targetId: runId, metadata: { code: mapped.code } });
        }
        finally {
            clearTimeout(timeout);
            this.controllers.delete(runId);
        }
    }
    async finish(run, usage, started) {
        const estimated = (BigInt(usage.inputTokens) * BigInt(this.configuration.inputUsdPerMillionTokens) +
            BigInt(usage.outputTokens) * BigInt(this.configuration.outputUsdPerMillionTokens)) / 1000000n;
        await repo.addUsage({
            runId: run.id, conversationId: run.conversationId, organizationId: run.organizationId,
            userId: run.userId, application: run.application, provider: run.provider, model: run.model,
            ...usage, latencyMs: Date.now() - started, estimatedCostMicrousd: estimated,
            pricingVersion: this.configuration.pricingVersion,
        });
        await repo.terminal(run.id, "COMPLETED");
        this.logger.info({ runId: run.id, organizationId: run.organizationId, userId: run.userId, provider: run.provider, model: run.model, totalTokens: usage.totalTokens, latencyMs: Date.now() - started }, "AI run completed");
        await repo.addEvent(run.id, "run.completed", { runId: run.id });
        await auditEvent({ actorId: run.userId, organizationId: run.organizationId, action: "ai.run.completed", targetType: "AIRun", targetId: run.id, metadata: { provider: run.provider, model: run.model, totalTokens: usage.totalTokens } });
    }
}
export const ai = new AIService();
