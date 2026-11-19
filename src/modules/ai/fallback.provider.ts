import type { AIProvider } from "./provider.interface.js";
import type { AIProviderRequest, AIStreamEvent } from "./provider.types.js";

const RECOVERABLE = new Set(["AI_PROVIDER_RATE_LIMITED", "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_TIMEOUT"]);

/**
 * Tries the primary provider and, if it fails with a quota/availability error before emitting anything, replays the whole
 * request on the fallback (which uses its own model). Runs keep reporting the primary's name and model.
 */
export class FallbackProvider implements AIProvider {
  readonly name: string;
  constructor(private readonly primary: AIProvider, private readonly secondary: AIProvider) { this.name = primary.name; }

  generate(request: AIProviderRequest, signal?: AbortSignal) {
    return this.primary.generate(request, signal).catch((error: { code?: string }) => {
      if (!RECOVERABLE.has(error?.code ?? "")) throw error;
      return this.secondary.generate(request, signal);
    });
  }

  async *stream(request: AIProviderRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
    let emitted = false;
    try {
      for await (const event of this.primary.stream(request, signal)) { emitted = true; yield event; }
    } catch (error) {
      if (emitted || !RECOVERABLE.has((error as { code?: string })?.code ?? "")) throw error;
      yield* this.secondary.stream(request, signal);
    }
  }
}
