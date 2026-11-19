import { DomainError } from "../../shared/errors.js";
import type { AIProvider } from "./provider.interface.js";
import type { AIProviderRequest, AIProviderResponse, AIStreamEvent } from "./provider.types.js";

/**
 * Any OpenAI-compatible chat-completions endpoint (Groq, Mistral, OpenRouter, Cerebras...). Used as a fallback when Gemini is
 * rate limited. ponytail: stream() runs one non-streaming call and replays it as events; add SSE if fallback latency matters.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private body(request: AIProviderRequest) {
    return {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: "system", content: request.systemInstruction },
        ...request.messages.map((message) =>
          message.role === "tool"
            ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
            : message.role === "assistant" && message.toolCalls?.length
              ? {
                  role: "assistant",
                  content: message.content || null,
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                  })),
                }
              : { role: message.role, content: message.content }),
      ],
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({
        type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })) } : {}),
    };
  }

  async generate(request: AIProviderRequest, signal?: AbortSignal): Promise<AIProviderResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(this.body(request)),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "AbortError" || name === "TimeoutError") throw new DomainError(504, "AI_PROVIDER_TIMEOUT", "AI provider timed out");
      throw new DomainError(503, "AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable");
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 429) throw new DomainError(429, "AI_PROVIDER_RATE_LIMITED", "AI provider rate limited the request");
      if (status === 401 || status === 403) throw new DomainError(503, "AI_PROVIDER_AUTHENTICATION_FAILED", "AI provider authentication failed");
      if (status === 400) throw new DomainError(502, "AI_PROVIDER_INVALID_REQUEST", "AI provider rejected the normalized request");
      if (status === 404) throw new DomainError(503, "AI_MODEL_UNAVAILABLE", "Configured AI model is unavailable");
      throw new DomainError(503, "AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable");
    }
    const json = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = json.choices?.[0];
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    return {
      text: choice?.message?.content ?? "",
      toolCalls: (choice?.message?.tool_calls ?? []).map((call, index) => {
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* model sent malformed arguments; the tool validates */ }
        return { id: call.id || `fallback-call-${index}`, name: call.function.name, arguments: args };
      }),
      usage: { inputTokens, outputTokens, totalTokens: json.usage?.total_tokens ?? inputTokens + outputTokens },
      finishReason: choice?.finish_reason,
    };
  }

  async *stream(request: AIProviderRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
    const response = await this.generate(request, signal);
    if (response.text) yield { type: "text.delta", text: response.text };
    for (const call of response.toolCalls) yield { type: "tool.call", call };
    yield { type: "completed", response };
  }
}
