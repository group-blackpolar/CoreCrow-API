import type {
  AIProviderRequest,
  AIProviderResponse,
  AIStreamEvent,
} from "./provider.types.js";

export interface AIProvider {
  readonly name: string;
  generate(request: AIProviderRequest, signal?: AbortSignal): Promise<AIProviderResponse>;
  stream(request: AIProviderRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent>;
}

