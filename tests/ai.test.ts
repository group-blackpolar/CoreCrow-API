import test from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider, geminiNormalization } from "../src/modules/ai/gemini.provider.js";
import { DomainError } from "../src/shared/errors.js";
import { resolveAITenantContextIn } from "../src/modules/ai/authorization.js";
import type { Transaction } from "../src/shared/transaction.js";
import {
  AIToolRegistry,
  aiOrganization,
  aiOrganizationMembers,
  aiUserProfile,
  type RegisteredAITool,
} from "../src/modules/ai/tool-registry.js";
import { AIService, assertPendingAIAction, boundedAIHistory, publicAIRun, reauthorizeAIAction } from "../src/modules/ai/service.js";
import type { AIProvider } from "../src/modules/ai/provider.interface.js";
import type { AIConfiguration } from "../src/modules/ai/config.js";

test("Gemini responses are normalized without leaking provider shapes", () => {
  const response = geminiNormalization.normalized({
    text: "done",
    functionCalls: [{ id: "call-1", name: "organization.current", args: {} }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
    candidates: [{ finishReason: "STOP" }],
  } as never);
  assert.deepEqual(response, {
    text: "done",
    toolCalls: [{ id: "call-1", name: "organization.current", arguments: {} }],
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    finishReason: "STOP",
  });
});

test("Gemini provider classifies rate, auth, missing model and network errors", () => {
  const cases = [
    [{ status: 429 }, "AI_PROVIDER_RATE_LIMITED"],
    [{ status: 403 }, "AI_PROVIDER_AUTHENTICATION_FAILED"],
    [{ status: 404 }, "AI_MODEL_UNAVAILABLE"],
    [new Error("network detail must not escape"), "AI_PROVIDER_UNAVAILABLE"],
  ] as const;
  for (const [input, code] of cases)
    assert.equal(geminiNormalization.providerError(input).code, code);
});

test("Gemini provider enforces its timeout", async () => {
  const models = {
    generateContent: (parameters: { config?: { abortSignal?: AbortSignal } }) =>
      new Promise((_resolve, reject) => parameters.config?.abortSignal?.addEventListener("abort", () => {
        const error = new Error("aborted"); error.name = "AbortError"; reject(error);
      })),
    generateContentStream: async () => { throw new Error("unused"); },
  } as never;
  const provider = new GeminiProvider("test", 5, "https://example.invalid", models);
  await assert.rejects(
    provider.generate({ model: "test", systemInstruction: "test", messages: [{ role: "user", content: "hi" }], tools: [] }),
    (error: unknown) => error instanceof DomainError && error.code === "AI_PROVIDER_TIMEOUT",
  );
});

test("AI tenant authorization rejects platform actors and grants without membership", async () => {
  for (const actorId of ["platform-admin", "platform-superadmin", "global-north-grant-holder", "cross-tenant-member"]) {
    let globalAuthorityRead = false;
    const tx = {
      organization: { findUnique: async () => ({ id: "org-a", status: "ACTIVE" }) },
      membership: { findUnique: async () => null },
      user: { findUnique: async () => { globalAuthorityRead = true; return { role: "SUPERADMIN" }; } },
      northPlatformGrant: { findMany: async () => { globalAuthorityRead = true; return [{ capability: "north.organization.manage_all" }]; } },
    } as unknown as Transaction;
    await assert.rejects(
      resolveAITenantContextIn(tx, actorId, "org-a"),
      (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND",
    );
    assert.equal(globalAuthorityRead, false);
  }
});

test("tool registry filters permissions, validates inputs and rejects hallucinated tools", async () => {
  const executed: unknown[] = [];
  const tool: RegisteredAITool = {
    name: "safe.read", description: "safe", application: "north", risk: "read",
    requiredPermissions: ["organization.read"],
    input: (await import("zod")).z.object({ id: (await import("zod")).z.string().min(1) }).strict(),
    handler: async (_context, input) => { executed.push(input); return { ok: true }; },
  };
  const registry = new AIToolRegistry([tool], async () => ({
    organization: { id: "org-a" }, member: { id: "member-a", role: "MEMBER" },
    permissions: ["organization.read"],
  }) as never);
  const context = { userId: "user-a", organizationId: "org-a", application: "north" as const };
  await assert.rejects(registry.execute(context, "missing", {}), (error: unknown) =>
    error instanceof DomainError && error.code === "AI_TOOL_UNAVAILABLE");
  await assert.rejects(registry.execute(context, "safe.read", {}), (error: unknown) =>
    error instanceof DomainError && error.code === "AI_INVALID_TOOL_CALL");
  assert.deepEqual((await registry.execute(context, "safe.read", { id: "real" })).result, { ok: true });
  assert.deepEqual(executed, [{ id: "real" }]);
});

test("tool registry withholds and rejects tools when permission is missing", async () => {
  const tool: RegisteredAITool = {
    name: "members.read", description: "members", application: "north", risk: "read",
    requiredPermissions: ["members.read"], input: (await import("zod")).z.object({}).strict(),
    handler: async () => ({ forbidden: true }),
  };
  const registry = new AIToolRegistry([tool], async () => ({
    organization: { id: "org-a" }, member: { id: "member-a", role: "MEMBER" }, permissions: ["organization.read"],
  }) as never);
  const context = { userId: "user-a", organizationId: "org-a", application: "north" as const };
  assert.deepEqual(await registry.available(context), []);
  await assert.rejects(registry.execute(context, "members.read", {}), (error: unknown) =>
    error instanceof DomainError && error.code === "AI_TOOL_UNAVAILABLE");
});

test("disabled AI fails before invoking the provider", async () => {
  let called = false;
  const provider: AIProvider = {
    name: "fake",
    async generate() { called = true; throw new Error("unexpected"); },
    async *stream() { called = true; throw new Error("unexpected"); },
  };
  const configuration: AIConfiguration = {
    enabled: false, provider: "gemini", model: "gemini-3.8-flash", geminiApiKey: "",
    geminiBaseUrl: "https://example.invalid", providerTimeoutMs: 1000, runTimeoutMs: 5000,
    maxToolRounds: 1, maxOutputTokens: 256, contextMaxMessages: 10,
    contextMaxCharacters: 8_000, messageMaxCharacters: 8_000,
    userConcurrentRuns: 1, organizationConcurrentRuns: 1,
    userRunsPerMinute: 1, organizationRunsPerMinute: 1, actionTtlSeconds: 60,
    pricingVersion: "test", inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0,
  };
  const service = new AIService(configuration, provider);
  await assert.rejects(
    service.createConversation("user", { organizationId: "org", application: "north" }),
    (error: unknown) => error instanceof DomainError && error.code === "AI_DISABLED",
  );
  assert.equal(called, false);
});

test("public AI runs serialize bigint cost estimates as decimal strings", () => {
  const value = publicAIRun({
    id: "run-a", conversationId: "conversation-a", organizationId: "org-a", userId: "user-a",
    application: "NORTH",
    status: "COMPLETED", provider: "gemini", model: "gemini-3.8-flash",
    failureCode: null, failureMessage: null, cancellationRequestedAt: null,
    startedAt: null, completedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    usage: [{ id: "usage-a", provider: "gemini", model: "gemini-3.8-flash",
      inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1,
      estimatedCostMicrousd: 9_007_199_254_740_993n, pricingVersion: "test", createdAt: new Date(0),
      internal: "must-not-leak" }],
    actions: [], toolCalls: [], internal: "must-not-leak",
  });
  assert.equal(value.application, "north");
  assert.equal(value.usage[0]?.estimatedCostMicrousd, "9007199254740993");
  assert.doesNotThrow(() => JSON.stringify(value));
  assert.doesNotMatch(JSON.stringify(value), /BigInt/);
  assert.doesNotMatch(JSON.stringify(value), /must-not-leak/);
});

test("AI context keeps only the newest messages within the character ceiling", () => {
  const messages = [
    { role: "user" as const, content: "old" },
    { role: "assistant" as const, content: "middle" },
    { role: "user" as const, content: "latest" },
  ];
  assert.deepEqual(boundedAIHistory(messages, 10), [
    { role: "assistant", content: "midd" },
    { role: "user", content: "latest" },
  ]);
});

test("user.me exposes only the minimum self-profile", () => {
  const profile = aiUserProfile({
    id: "user-a", email: "person@example.com", name: "Person",
    role: "SUPERADMIN", status: "ACTIVE", termsVersion: "secret-context",
  });
  assert.deepEqual(profile, { id: "user-a", email: "person@example.com", name: "Person" });
  assert.deepEqual(Object.keys(profile).sort(), ["email", "id", "name"]);
});

test("organization tools expose only minimum tenant context", () => {
  const organization = aiOrganization({
    id: "org-a",
    name: "Alpha",
    slug: "alpha",
    status: "ACTIVE",
    storageLimitBytes: 10_000n,
    storageUsedBytes: 1_000n,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  });
  assert.deepEqual(organization, {
    id: "org-a",
    name: "Alpha",
    slug: "alpha",
    status: "ACTIVE",
  });
  assert.deepEqual(Object.keys(organization).sort(), ["id", "name", "slug", "status"]);

  const members = aiOrganizationMembers([{
    id: "membership-a",
    organizationId: "org-a",
    userId: "user-a",
    role: "OWNER",
    createdAt: new Date("2026-01-01"),
  }]);
  assert.deepEqual(members, [{ userId: "user-a", role: "OWNER" }]);
  assert.deepEqual(Object.keys(members[0]!).sort(), ["role", "userId"]);
});

test("AI SSE replay is CORS-safe and documented as an authenticated event stream", async () => {
  const previous = {
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: process.env.TRUSTED_ORIGINS,
  };
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "ai-contract-test-only-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://north.test";
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  try {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/ai/runs/run-a/events?organizationId=org-a",
      headers: {
        origin: "http://north.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "last-event-id",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.match(preflight.headers["access-control-allow-headers"] ?? "", /Last-Event-ID/i);

    const specification = app.swagger() as {
      paths: Record<string, Record<string, {
        security?: Array<Record<string, unknown>>;
        parameters?: Array<{ in: string; name: string }>;
        responses: Record<string, { content?: Record<string, unknown> }>;
      }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    const operation = specification.paths["/v1/ai/runs/{id}/events"]!.get!;
    assert.deepEqual(operation.security, [{ sessionCookie: [] }, { desktopBearer: [] }]);
    assert.ok(specification.components?.securitySchemes?.desktopBearer);
    assert.ok(operation.parameters?.some((parameter) =>
      parameter.in === "header" && parameter.name.toLowerCase() === "last-event-id"));
    assert.ok(operation.responses["200"]?.content?.["text/event-stream"]);
    assert.ok(operation.responses["5XX"] ?? operation.responses["5xx"]);
    for (const [path, methods] of Object.entries(specification.paths)) {
      if (!path.startsWith("/v1/ai/")) continue;
      for (const candidate of Object.values(methods))
        assert.deepEqual(candidate.security, [{ sessionCookie: [] }, { desktopBearer: [] }]);
    }
  } finally {
    await app.close();
    if (previous.betterAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previous.betterAuthUrl;
    if (previous.betterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous.betterAuthSecret;
    if (previous.trustedOrigins === undefined) delete process.env.TRUSTED_ORIGINS;
    else process.env.TRUSTED_ORIGINS = previous.trustedOrigins;
  }
});

test("AI action state validation fails closed for cancelled and expired actions", () => {
  assert.doesNotThrow(() => assertPendingAIAction({ status: "PENDING_CONFIRMATION", expiresAt: new Date("2030-01-01") }, new Date("2029-01-01")));
  assert.throws(
    () => assertPendingAIAction({ status: "CANCELLED", expiresAt: new Date("2030-01-01") }, new Date("2029-01-01")),
    (error: unknown) => error instanceof DomainError && error.code === "AI_ACTION_NOT_PENDING",
  );
  assert.throws(
    () => assertPendingAIAction({ status: "PENDING_CONFIRMATION", expiresAt: new Date("2028-01-01") }, new Date("2029-01-01")),
    (error: unknown) => error instanceof DomainError && error.code === "AI_ACTION_EXPIRED",
  );
});

test("AI action confirmation reauthorizes the original actor and tenant", async () => {
  const calls: unknown[] = [];
  const authorizer = async (userId: string, organizationId: string, permissions: readonly string[]) => {
    calls.push({ userId, organizationId, permissions });
    return { permissions };
  };
  await reauthorizeAIAction(authorizer as never, "user-a", {
    userId: "user-a", organizationId: "org-a",
  }, ["organization.read"]);
  assert.deepEqual(calls, [{ userId: "user-a", organizationId: "org-a", permissions: ["organization.read"] }]);
  await assert.rejects(
    reauthorizeAIAction(authorizer as never, "user-b", { userId: "user-a", organizationId: "org-a" }, []),
    (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND",
  );
  assert.equal(calls.length, 1);
});
