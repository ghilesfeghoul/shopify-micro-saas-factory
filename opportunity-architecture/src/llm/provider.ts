/**
 * LLM Provider abstraction.
 * Identical interface to opportunity-detector for consistency.
 */

export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  jsonSchema: Record<string, unknown>;
  toolName?: string;
  maxTokens?: number;
}

export interface LLMResponse {
  data: Record<string, unknown>;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs: number;
  };
  backend: 'anthropic-api' | 'claude-code';
  model?: string;
}

export interface LLMProvider {
  readonly name: string;
  analyze(request: LLMRequest): Promise<LLMResponse>;
}
