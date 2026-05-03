/**
 * LLM Provider abstraction.
 *
 * Used for:
 * - Architect-API-style structured outputs (rare in dev agent — only for planning)
 * - Most actual code generation goes through ClaudeCodeSpawner directly,
 *   which is a higher-fidelity wrapper that gives Claude Code real tools
 *   (Read/Write/Edit/Bash) and access to user-installed skills.
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
