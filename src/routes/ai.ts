import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { ai } from "../modules/ai/service.js";
import { principal } from "../modules/security/session.js";

const application = z.literal("north");
const security: Array<Record<string, never[]>> = [
  { sessionCookie: [] },
  { desktopBearer: [] },
];
const status = z.enum(["QUEUED", "RUNNING", "WAITING_CONFIRMATION", "COMPLETED", "FAILED", "CANCELLED"]);
const actionStatus = z.enum(["PENDING_CONFIRMATION", "CONFIRMED", "CANCELLED", "EXPIRED", "FAILED"]);
const conversation = z.object({
  id: s.id, organizationId: s.id, userId: s.id, application,
  title: z.string().nullable(), createdAt: s.date, updatedAt: s.date,
});
const message = z.object({
  id: s.id, runId: s.id.nullable(), role: z.enum(["USER", "ASSISTANT", "TOOL"]),
  content: z.string(), toolName: z.string().nullable(), toolCallId: z.string().nullable(), createdAt: s.date,
});
const usage = z.object({
  id: s.id, provider: z.string(), model: z.string(), inputTokens: z.number().int(),
  outputTokens: z.number().int(), totalTokens: z.number().int(), latencyMs: z.number().int(),
  estimatedCostMicrousd: z.string().regex(/^\d+$/), pricingVersion: z.string(), createdAt: s.date,
}).strict();
const action = z.object({ id: s.id, status: actionStatus, toolName: z.string(), expiresAt: s.date }).strict();
const toolCall = z.object({ id: s.id, name: z.string(), risk: z.string(), status: z.string(), errorCode: z.string().nullable() }).strict();
const run = z.object({
  id: s.id, conversationId: s.id, organizationId: s.id, userId: s.id,
  application, status, provider: z.string(), model: z.string(), failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(), cancellationRequestedAt: s.date.nullable(),
  startedAt: s.date.nullable(), completedAt: s.date.nullable(), createdAt: s.date, updatedAt: s.date,
  usage: z.array(usage), actions: z.array(action), toolCalls: z.array(toolCall),
}).strict();

export async function aiRoutes(app: FastifyInstance) {
  ai.configureLogger(app.log);
  contract(app, {
    method: "POST", url: "/ai/conversations", tag: "CoreCrow AI",
    security,
    summary: "Create a membership-bound AI conversation",
    body: z.object({ organizationId: s.id, application, title: z.string().trim().min(1).max(120).optional() }).strict(),
    response: conversation, status: 201, rateLimit: 10,
    run: ({ user, body }) => ai.createConversation(user.id, body),
  });
  contract(app, {
    method: "GET", url: "/ai/conversations", tag: "CoreCrow AI",
    security,
    summary: "List the actor's tenant-isolated AI conversations",
    query: z.object({ organizationId: s.id }).strict(), response: z.array(conversation),
    run: ({ user, query }) => ai.listConversations(user.id, query.organizationId),
  });
  contract(app, {
    method: "GET", url: "/ai/conversations/:id", tag: "CoreCrow AI",
    security,
    summary: "Read one tenant-isolated AI conversation and its messages",
    params: z.object({ id: s.id }).strict(), query: z.object({ organizationId: s.id }).strict(),
    response: conversation.extend({ messages: z.array(message) }),
    run: ({ user, params, query }) => ai.conversation(user.id, query.organizationId, params.id),
  });
  contract(app, {
    method: "POST", url: "/ai/runs", tag: "CoreCrow AI",
    security,
    summary: "Queue an asynchronous Gemini-backed AI run",
    body: z.object({
      organizationId: s.id, conversationId: s.id, application,
      message: z.string().trim().min(1).max(8_000),
    }).strict(),
    response: z.object({ runId: s.id }), status: 202, rateLimit: 10,
    run: ({ user, body }) => ai.createRun(user.id, body),
  });
  contract(app, {
    method: "GET", url: "/ai/runs/:id", tag: "CoreCrow AI",
    security,
    summary: "Read an owned tenant-isolated AI run",
    params: z.object({ id: s.id }).strict(), query: z.object({ organizationId: s.id }).strict(), response: run,
    run: ({ user, params, query }) => ai.run(user.id, query.organizationId, params.id),
  });
  contract(app, {
    method: "POST", url: "/ai/runs/:id/cancel", tag: "CoreCrow AI",
    security,
    summary: "Request cancellation of an owned AI run",
    params: z.object({ id: s.id }).strict(), body: z.object({ organizationId: s.id }).strict(), response: run,
    run: ({ user, params, body }) => ai.cancelRun(user.id, body.organizationId, params.id),
  });
  contract(app, {
    method: "POST", url: "/ai/actions/:id/confirm", tag: "CoreCrow AI",
    security,
    summary: "Reauthorize and confirm an AI action (no mutation tools enabled in MVP)",
    params: z.object({ id: s.id }).strict(), response: action,
    run: ({ user, params }) => ai.confirmAction(user.id, params.id),
  });
  contract(app, {
    method: "POST", url: "/ai/actions/:id/cancel", tag: "CoreCrow AI",
    security,
    summary: "Cancel a pending owned AI action",
    params: z.object({ id: s.id }).strict(), response: action,
    run: ({ user, params }) => ai.cancelAction(user.id, params.id),
  });

  const eventQuery = z.object({ organizationId: s.id, after: z.coerce.number().int().min(0).default(0) }).strict();
  app.get("/ai/runs/:id/events", {
    schema: {
      tags: ["CoreCrow AI"], summary: "Stream persisted AI run events with terminal replay",
      security: [{ sessionCookie: [] }, { desktopBearer: [] }],
      produces: ["text/event-stream"],
      headers: {
        type: "object",
        properties: {
          "last-event-id": {
            type: "string",
            pattern: "^[0-9]+$",
            description: "Last received event sequence for resumable replay.",
          },
        },
        additionalProperties: true,
      },
      params: zodToJsonSchema(z.object({ id: s.id }).strict(), { target: "openApi3" }),
      querystring: zodToJsonSchema(eventQuery, { target: "openApi3" }),
      response: {
        200: { type: "string", description: "Persisted Server-Sent Events stream." },
        "4xx": zodToJsonSchema(s.error, { target: "openApi3" }),
        "5xx": zodToJsonSchema(s.error, { target: "openApi3" }),
      },
    },
  }, async (request, reply) => {
    const user = await principal(request);
    const params = z.object({ id: s.id }).parse(request.params);
    const query = eventQuery.parse(request.query);
    await ai.run(user.id, query.organizationId, params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let after = Math.max(query.after, Number(request.headers["last-event-id"] ?? 0) || 0);
    let closed = false;
    request.raw.on("close", () => { closed = true; });
    let heartbeat = Date.now();
    while (!closed) {
      const batch = await ai.events(user.id, query.organizationId, params.id, after);
      for (const event of batch.events) {
        reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        after = event.sequence;
      }
      if (batch.terminal) break;
      if (Date.now() - heartbeat >= 15_000) {
        reply.raw.write(": heartbeat\n\n");
        heartbeat = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!closed) reply.raw.end();
  });
}
