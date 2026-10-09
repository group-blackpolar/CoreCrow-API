import { fail } from "../../shared/errors.js";

function integer(name: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(500, "AI_CONFIGURATION_INVALID", `Invalid ${name} configuration`);
  return value;
}

function boolean(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  fail(500, "AI_CONFIGURATION_INVALID", `Invalid ${name} configuration`);
}

function thinkingLevel(): "minimal" | "low" | "medium" | "high" | undefined {
  const raw = process.env.AI_THINKING_LEVEL?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") return raw;
  fail(500, "AI_CONFIGURATION_INVALID", "Invalid AI_THINKING_LEVEL configuration");
}

export type AIConfiguration = ReturnType<typeof aiConfiguration>;

export function aiConfiguration() {
  const provider = process.env.AI_PROVIDER?.trim() || "gemini";
  if (provider !== "gemini")
    fail(503, "AI_PROVIDER_UNAVAILABLE", "Configured AI provider is unavailable");
  return {
    enabled: boolean("AI_ENABLED", false),
    provider,
    // Gemini 2.5 Flash is closed to new API users (Google answers 404); 3.8 Flash is Google's documented replacement.
    model: process.env.AI_DEFAULT_MODEL?.trim() || "gemini-3.8-flash",
    thinkingLevel: thinkingLevel(),
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || "",
    geminiBaseUrl:
      process.env.AI_GEMINI_BASE_URL?.trim() ||
      "https://generativelanguage.googleapis.com",
    providerTimeoutMs: integer("AI_PROVIDER_TIMEOUT_MS", 45_000, 1_000),
    runTimeoutMs: integer("AI_RUN_TIMEOUT_MS", 90_000, 5_000),
    maxToolRounds: integer("AI_MAX_TOOL_ROUNDS", 4),
    maxOutputTokens: integer("AI_MAX_OUTPUT_TOKENS", 2_048, 1, 8_192),
    contextMaxMessages: integer("AI_CONTEXT_MAX_MESSAGES", 50, 1, 100),
    contextMaxCharacters: integer("AI_CONTEXT_MAX_CHARACTERS", 64_000, 8_000, 256_000),
    messageMaxCharacters: integer("AI_MESSAGE_MAX_CHARACTERS", 8_000, 1, 8_000),
    userConcurrentRuns: integer("AI_USER_CONCURRENT_RUNS", 1),
    organizationConcurrentRuns: integer("AI_ORGANIZATION_CONCURRENT_RUNS", 3),
    userRunsPerMinute: integer("AI_USER_RUNS_PER_MINUTE", 6),
    organizationRunsPerMinute: integer("AI_ORGANIZATION_RUNS_PER_MINUTE", 30),
    actionTtlSeconds: integer("AI_ACTION_TTL_SECONDS", 600, 30),
    pricingVersion: process.env.AI_PRICING_VERSION?.trim() || "unpriced-v1",
    inputUsdPerMillionTokens: integer("AI_INPUT_USD_MICROS_PER_MILLION_TOKENS", 0, 0),
    outputUsdPerMillionTokens: integer("AI_OUTPUT_USD_MICROS_PER_MILLION_TOKENS", 0, 0),
  };
}

export function requireAIEnabled(configuration = aiConfiguration()) {
  if (!configuration.enabled)
    fail(503, "AI_DISABLED", "CoreCrow AI is disabled");
  if (!configuration.geminiApiKey)
    fail(503, "AI_PROVIDER_NOT_CONFIGURED", "AI provider is not configured");
  return configuration;
}
