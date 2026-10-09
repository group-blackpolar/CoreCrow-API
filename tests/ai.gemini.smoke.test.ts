import test from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../src/modules/ai/gemini.provider.js";
import type { AIProviderRequest } from "../src/modules/ai/provider.types.js";

// Opt-in, real-provider smoke: AI_REAL_GEMINI_SMOKE=true GEMINI_API_KEY=... (the key is read from the environment and never printed).
const enabled = process.env.AI_REAL_GEMINI_SMOKE === "true" && Boolean(process.env.GEMINI_API_KEY);
const apiKey = process.env.GEMINI_API_KEY ?? "";
const model = process.env.AI_DEFAULT_MODEL ?? "gemini-2.5-flash";
const baseUrl = process.env.AI_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
const timeout = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 45_000);
const provider = () => new GeminiProvider(apiKey, timeout, baseUrl);

const lookupTool = {
  name: "lookup_status",
  description: "Read-only lookup of the current status of a named service. Takes no action and changes nothing.",
  inputSchema: { type: "object", properties: { service: { type: "string", description: "Service name" } }, required: ["service"], additionalProperties: false },
};
const request = (overrides: Partial<AIProviderRequest>): AIProviderRequest => ({
  model, maxOutputTokens: 256, systemInstruction: "Be brief.", messages: [], tools: [], ...overrides,
});

test("real Gemini 2.5 Flash: simple response with usage", { skip: !enabled }, async () => {
  const response = await provider().generate(request({ systemInstruction: "Reply with exactly OK.", messages: [{ role: "user", content: "Connectivity check" }] }));
  assert.match(response.text.trim(), /^OK[.!]?$/i);
  assert.ok(response.usage.totalTokens > 0);
  assert.equal(response.toolCalls.length, 0);
});

test("real Gemini 2.5 Flash: read-only tool call, then a final answer from the tool result", { skip: !enabled }, async () => {
  const first = await provider().generate(request({
    systemInstruction: "You must call lookup_status to answer questions about service status. Never guess.",
    messages: [{ role: "user", content: "What is the status of the service named alpha?" }],
    tools: [lookupTool],
    maxOutputTokens: 512,
  }));
  assert.ok(first.toolCalls.length >= 1, "the model requested the tool");
  const call = first.toolCalls[0]!;
  assert.equal(call.name, "lookup_status");
  assert.match(String((call.arguments as { service?: string }).service ?? ""), /alpha/i);

  const final = await provider().generate(request({
    systemInstruction: "Answer only from the tool result. Quote the status code exactly.",
    messages: [
      { role: "user", content: "What is the status of the service named alpha?" },
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", toolName: call.name, toolCallId: call.id, content: JSON.stringify({ service: "alpha", status: "GREEN-42" }) },
    ],
    tools: [lookupTool],
    maxOutputTokens: 512,
  }));
  assert.match(final.text, /GREEN-42/);
  assert.equal(final.toolCalls.length, 0);
});

test("real Gemini 2.5 Flash: streaming yields deltas and a completed event", { skip: !enabled }, async () => {
  const events: string[] = [];
  for await (const event of provider().stream(request({ systemInstruction: "Reply with exactly: stream ok", messages: [{ role: "user", content: "go" }] }))) events.push(event.type);
  assert.equal(events.at(-1), "completed");
  assert.ok(events.includes("text.delta"));
});

test("real Gemini 2.5 Flash: provider failures are normalized and never carry the key", { skip: !enabled }, async () => {
  const seen: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of ["log", "info", "warn", "error"] as const) console[level] = (...args: unknown[]) => { seen.push(args.map(String).join(" ")); };
  try {
    const cases: Array<[string, () => Promise<unknown>, string[]]> = [
      ["bad key", () => new GeminiProvider("invalid-key-for-smoke-test-0000000000", timeout, baseUrl).generate(request({ messages: [{ role: "user", content: "hi" }] })), ["AI_PROVIDER_AUTHENTICATION_FAILED", "AI_PROVIDER_INVALID_REQUEST"]],
      ["unknown model", () => provider().generate(request({ model: "gemini-does-not-exist-0", messages: [{ role: "user", content: "hi" }] })), ["AI_MODEL_UNAVAILABLE", "AI_PROVIDER_INVALID_REQUEST"]],
      ["timeout", () => new GeminiProvider(apiKey, 1, baseUrl).generate(request({ messages: [{ role: "user", content: "hi" }] })), ["AI_PROVIDER_TIMEOUT", "AI_PROVIDER_UNAVAILABLE"]],
    ];
    for (const [label, run, allowed] of cases) {
      const error = await run().then(() => null, (reason) => reason as { code?: string; message?: string; statusCode?: number });
      assert.ok(error, `${label} must fail`);
      assert.ok(allowed.includes(String(error.code)), `${label}: normalized code, got ${error.code}`);
      const serialized = `${error.message} ${JSON.stringify(error)} ${String((error as Error).stack ?? "")}`;
      assert.equal(serialized.includes(apiKey), false, `${label}: the API key must not appear in the error`);
    }
  } finally { Object.assign(console, originals); }
  assert.equal(seen.join("\n").includes(apiKey), false, "the API key must not appear in logs");
});
