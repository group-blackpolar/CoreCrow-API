import test from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../src/modules/ai/gemini.provider.js";

const enabled = process.env.AI_REAL_GEMINI_SMOKE === "true" && Boolean(process.env.GEMINI_API_KEY);

test("real Gemini 2.5 Flash smoke", { skip: !enabled }, async () => {
  const provider = new GeminiProvider(
    process.env.GEMINI_API_KEY!,
    Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 45_000),
    process.env.AI_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
  );
  const response = await provider.generate({
    model: process.env.AI_DEFAULT_MODEL ?? "gemini-2.5-flash",
    systemInstruction: "Reply with exactly OK.",
    messages: [{ role: "user", content: "Connectivity check" }], tools: [],
  });
  assert.match(response.text.trim(), /^OK[.!]?$/i);
  assert.ok(response.usage.totalTokens >= 0);
});

