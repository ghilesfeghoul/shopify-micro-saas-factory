/**
 * LLM Provider abstraction.
 *
 * Two backends supported:
 * 1. AnthropicAPIProvider — uses @anthropic-ai/sdk, paid per-token, works anywhere
 * 2. ClaudeCodeProvider   — invokes `claude -p` CLI, uses Pro subscription quota,
 *                           requires `claude` to be installed and authenticated locally
 *
 * Both implementations return the same shape, so the analyzer doesn't care
 * which one is active.
 */

import type { Opportunity } from '../utils/types';

export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
}

export interface LLMResponse {
  /** The structured output that conforms to the requested JSON schema */
  data: { opportunities: unknown[] };
  /** Token / cost telemetry for observability */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs: number;
  };
  /** Which backend produced this response */
  backend: 'anthropic-api' | 'claude-code';
}

export interface LLMProvider {
  readonly name: string;
  analyze(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Type-narrowing helper for downstream code that wants opportunities specifically.
 */
export type OpportunityArray = Opportunity[];
