export type AIProviderMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: AIToolCall[];
};

export type AIProviderTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AIToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AIProviderRequest = {
  model: string;
  maxOutputTokens: number;
  systemInstruction: string;
  messages: AIProviderMessage[];
  tools: AIProviderTool[];
};

export type AIProviderResponse = {
  text: string;
  toolCalls: AIToolCall[];
  usage: AIUsage;
  finishReason?: string;
};

export type AIStreamEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.call"; call: AIToolCall }
  | { type: "completed"; response: AIProviderResponse };
