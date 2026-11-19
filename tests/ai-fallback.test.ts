import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/shared/errors.js";
import { FallbackProvider } from "../src/modules/ai/fallback.provider.js";
import { OpenAICompatibleProvider } from "../src/modules/ai/openai.provider.js";

const request = { model: "gemini-x", maxOutputTokens: 16, systemInstruction: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("fallback takes over when the primary is rate limited, and not on other errors", async () => {
  const backup = new OpenAICompatibleProvider("k", "https://example.invalid/v1", "backup-model", 1000, (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, "backup-model");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [{ id: "c1", function: { name: "t", arguments: "{\"a\":1}" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  }) as typeof fetch);
  const limited = { name: "gemini", generate: async () => { throw new DomainError(429, "AI_PROVIDER_RATE_LIMITED", "x"); }, stream: async function* () { throw new DomainError(429, "AI_PROVIDER_RATE_LIMITED", "x"); } };
  const provider = new FallbackProvider(limited, backup);
  const response = await provider.generate(request);
  assert.equal(response.text, "ok");
  assert.deepEqual(response.toolCalls[0], { id: "c1", name: "t", arguments: { a: 1 } });
  assert.equal(response.usage.totalTokens, 5);
  const events = [];
  for await (const event of provider.stream(request)) events.push(event.type);
  assert.deepEqual(events, ["text.delta", "tool.call", "completed"]);
  const invalid = { ...limited, generate: async () => { throw new DomainError(502, "AI_PROVIDER_INVALID_REQUEST", "x"); } };
  await assert.rejects(new FallbackProvider(invalid, backup).generate(request), { code: "AI_PROVIDER_INVALID_REQUEST" });
});
