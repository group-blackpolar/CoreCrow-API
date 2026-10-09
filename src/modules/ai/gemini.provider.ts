import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { DomainError } from "../../shared/errors.js";
import type { AIProvider } from "./provider.interface.js";
import type {
  AIProviderRequest,
  AIProviderResponse,
  AIStreamEvent,
} from "./provider.types.js";

type GeminiModels = Pick<GoogleGenAI["models"], "generateContent" | "generateContentStream">;

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function contents(request: AIProviderRequest): Content[] {
  return request.messages.map((message) => {
    if (message.role === "tool") {
      let response: unknown = message.content;
      try { response = JSON.parse(message.content); } catch { /* string result */ }
      return {
        role: "user",
        parts: [{ functionResponse: {
          id: message.toolCallId,
          name: message.toolName ?? "unknown",
          response: { result: response },
        } }],
      };
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({ functionCall: {
          id: call.id, name: call.name, args: call.arguments as Record<string, unknown>,
        } })),
      ],
    };
  });
}

function normalized(response: GenerateContentResponse): AIProviderResponse {
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  const calls = response.functionCalls ?? [];
  return {
    text: response.text ?? "",
    toolCalls: calls.map((call, index) => ({
      id: call.id ?? `gemini-call-${index}`,
      name: call.name ?? "",
      arguments: call.args ?? {},
    })),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: response.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
    },
    finishReason: response.candidates?.[0]?.finishReason,
  };
}

function providerError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const candidate = error as { status?: number; code?: number | string; name?: string };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError")
    return new DomainError(504, "AI_PROVIDER_TIMEOUT", "AI provider timed out");
  const status = Number(candidate.status ?? candidate.code);
  if (status === 429)
    return new DomainError(429, "AI_PROVIDER_RATE_LIMITED", "AI provider rate limited the request");
  if (status === 401 || status === 403)
    return new DomainError(503, "AI_PROVIDER_AUTHENTICATION_FAILED", "AI provider authentication failed");
  if (status === 400)
    return new DomainError(502, "AI_PROVIDER_INVALID_REQUEST", "AI provider rejected the normalized request");
  if (status === 404)
    return new DomainError(503, "AI_MODEL_UNAVAILABLE", "Configured AI model is unavailable");
  return new DomainError(503, "AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable");
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private readonly models: GeminiModels;

  constructor(
    apiKey: string,
    private readonly timeoutMs: number,
    baseUrl: string,
    models?: GeminiModels,
  ) {
    this.models = models ?? new GoogleGenAI({ apiKey, httpOptions: { baseUrl } }).models;
  }

  private parameters(request: AIProviderRequest, signal?: AbortSignal) {
    return {
      model: request.model,
      contents: contents(request),
      config: {
        systemInstruction: request.systemInstruction,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: combinedSignal(signal, this.timeoutMs),
        httpOptions: { timeout: this.timeoutMs },
        ...(request.tools.length ? { tools: [{
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          })),
        }] } : {}),
      },
    };
  }

  async generate(request: AIProviderRequest, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return normalized(await this.models.generateContent(this.parameters(request, signal)));
      } catch (error) {
        const mapped = providerError(error);
        if (attempt < 1 && ["AI_PROVIDER_RATE_LIMITED", "AI_PROVIDER_UNAVAILABLE"].includes(mapped.code))
          continue;
        throw mapped;
      }
    }
  }

  async *stream(request: AIProviderRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        const source = await this.models.generateContentStream(this.parameters(request, signal));
        let text = "";
        let final: GenerateContentResponse | undefined;
        for await (const chunk of source) {
          final = chunk;
          const delta = chunk.text ?? "";
          text += delta;
          if (delta) { emitted = true; yield { type: "text.delta", text: delta }; }
          for (const call of normalized(chunk).toolCalls) {
            emitted = true;
            yield { type: "tool.call", call };
          }
        }
        const response = final ? normalized(final) : {
          text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
        response.text = text || response.text;
        yield { type: "completed", response };
        return;
      } catch (error) {
        const mapped = providerError(error);
        if (!emitted && attempt < 1 && ["AI_PROVIDER_RATE_LIMITED", "AI_PROVIDER_UNAVAILABLE"].includes(mapped.code))
          continue;
        throw mapped;
      }
    }
  }
}

export const geminiNormalization = { normalized, providerError };
